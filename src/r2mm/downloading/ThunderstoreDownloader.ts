import ThunderstoreMod from 'src/model/ThunderstoreMod';
import VersionNumber from 'src/model/VersionNumber';
import ThunderstoreVersion from 'src/model/ThunderstoreVersion';
import axios from 'axios';
import StatusEnum from 'src/model/enums/StatusEnum';
import DownloadError from 'src/model/errors/DownloadError';
import Profile from 'src/model/Profile';
import FileWriteError from 'src/model/errors/FileWriteError';

import * as fs from 'fs-extra';
import * as path from 'path';
import ZipExtract from '../installing/ZipExtract';
import R2Error from 'src/model/errors/R2Error';
import { isUndefined } from 'util';

const cacheDirectory: string = path.join(process.cwd(), 'mods', 'cache');

export default class ThunderstoreDownloader {

    private mod: ThunderstoreMod;
    private profile: Profile;

    public constructor(mod: ThunderstoreMod) {
        this.mod = mod;
        this.profile = Profile.getActiveProfile();
    }

    /** 
     * Download mod's zip file. 
     * If download fails, alert callback that an error has occured.
     * Callback should log this error.
    */
    public download(callback: Function, versionNumber: VersionNumber) {
        const tsVersions: ThunderstoreVersion[] = this.mod.getVersions();
        const version: ThunderstoreVersion | undefined = tsVersions.find((v: ThunderstoreVersion) => v.getVersionNumber().toString() === versionNumber.toString());
        
        if (version !== undefined) {
            if (this.isVersionAlreadyDownloaded(versionNumber)) {
                callback(100, StatusEnum.SUCCESS);
                return;
            }
            axios.get(version.getDownloadUrl(), {
                onDownloadProgress: progress => {
                    callback(progress, StatusEnum.PENDING);
                },
                responseType: 'arraybuffer'
            }).then(response => {
                const buf: Buffer = Buffer.from(response.data)
                callback(100, StatusEnum.PENDING);
                this.saveToFile(buf, versionNumber, (success: boolean) => {
                    if (success) {
                        callback(100, StatusEnum.SUCCESS);
                    } else {
                        callback(100, StatusEnum.FAILURE);
                    }
                });
            })
        } else {
            callback(0, StatusEnum.FAILURE, 
                new DownloadError(
                    'Download failure', 
                    `Failed to find version of mod: ${this.mod.getName()}, with version of: ${versionNumber.toString}`
                )
            );
        }
    }

    public downloadWithDependencies(callback: (progress: number, status: number, error: R2Error | void) => void, mod: ThunderstoreMod, version: ThunderstoreVersion, modList: ThunderstoreMod[]) {
        const dependencyList = this.buildDependencyList(version, modList);
        if (dependencyList instanceof R2Error) {
            callback(
                0, 
                StatusEnum.FAILURE, 
                dependencyList
            );
            return;
        }
        let listStep = 0;
        const downloader = new ThunderstoreDownloader(dependencyList[listStep]);
        const onFinalDownload = (progress: number, status: number, error: R2Error | void) => {
            if (status === StatusEnum.SUCCESS) {
                callback(100, StatusEnum.SUCCESS);
            } else if (status === StatusEnum.FAILURE && error instanceof R2Error) {
                callback(0, StatusEnum.FAILURE, error);
            }
        }
        const onStepDownload = (progress: number, status: number, error: R2Error | void) => {
            if (status === StatusEnum.SUCCESS) {
                listStep += 1;
                if (listStep < dependencyList.length) {
                    const downloader = new ThunderstoreDownloader(dependencyList[listStep]);
                    downloader.download(onStepDownload, dependencyList[listStep].getVersions()[0].getVersionNumber());
                } else {
                    const downloader = new ThunderstoreDownloader(mod);
                    downloader.download(onFinalDownload, version.getVersionNumber());
                }
            } else if (status === StatusEnum.FAILURE && error instanceof R2Error) {
                callback(
                    0, 
                    StatusEnum.FAILURE, 
                    error)
            }
        }
        if (dependencyList.length > 0) {
            downloader.download(onStepDownload, dependencyList[listStep].getVersions()[0].getVersionNumber());
        } else {
            onStepDownload(100, StatusEnum.SUCCESS);
        }
    }

    public buildDependencyList(version: ThunderstoreVersion, modList: ThunderstoreMod[]): ThunderstoreMod[] | R2Error {
        const list: ThunderstoreMod[] = [];
        try {
            version.getDependencies().forEach((dependency: string) => {
                const foundMod = modList.find((listMod: ThunderstoreMod) => dependency.startsWith(listMod.getFullName()));
                if (isUndefined(foundMod)) {
                    throw new Error(`Unable to find Thunderstore dependency with author-name of ${dependency}`)
                } else {
                    list.push(foundMod);
                    const findDependencyError = this.buildDependencyList(foundMod, modList);
                    if (findDependencyError instanceof R2Error) {
                        throw findDependencyError;
                    }
                    list.push(...findDependencyError);
                }
            })
        } catch(e) {
            const err: Error = e;
            return new R2Error(
                `Failed to find all dependencies of mod ${version.getFullName()}`,
                err.message
            )
        }
        return list;
    }

    private saveToFile(response: Buffer, versionNumber: VersionNumber, callback: (success: boolean) => void): R2Error | null {
        try {
            fs.mkdirsSync(path.join(cacheDirectory, this.mod.getFullName()));
            fs.writeFileSync(
                path.join(
                    cacheDirectory, 
                    this.mod.getFullName(), 
                    versionNumber.toString() + '.zip'
                ), 
                response
            );
            const extractError: R2Error | null = ZipExtract.extractAndDelete(
                path.join(cacheDirectory, this.mod.getFullName()), 
                versionNumber.toString() + '.zip', 
                versionNumber.toString(),
                callback
            );
            return extractError;
        } catch(e) {
            const err: Error = e;
            return new FileWriteError(
                'File write error',
                `Failed to write downloaded zip of ${this.mod.getFullName()} to profile directory of ${this.profile.getPathOfProfile()}. \nReason: ${err.message}`
            );
        }
        return null;
    }

    private isVersionAlreadyDownloaded(versionNumber: VersionNumber): boolean  {
        try {
            fs.opendirSync(path.join(cacheDirectory, this.mod.getFullName(), versionNumber.toString()));
            return true;
        } catch(e) {
            return false;
        }
    }

}