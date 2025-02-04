"use strict";
exports.downloadClangVersion = exports.getClangEnvironmentVars = void 0;
const cp = require("child_process");
const debug = require("debug");
const fs = require("fs-extra");
const got_1 = require("got");
const path = require("path");
const tar = require("tar");
const zlib = require("zlib");
const constants_1 = require("./constants");
const d = debug('electron-rebuild');
function sleep(n) {
    return new Promise(r => setTimeout(r, n));
}
async function fetch(url, responseType, retries = 3) {
    if (retries === 0)
        throw new Error('Failed to fetch a clang resource, run with DEBUG=electron-rebuild for more information');
    d('downloading:', url);
    try {
        const response = await got_1.default.get(url, {
            responseType,
        });
        if (response.statusCode !== 200) {
            d('got bad status code:', response.statusCode);
            await sleep(2000);
            return fetch(url, responseType, retries - 1);
        }
        d('response came back OK');
        return response.body;
    }
    catch (err) {
        d('request failed for some reason', err);
        await sleep(2000);
        return fetch(url, responseType, retries - 1);
    }
}
const CDS_URL = 'https://commondatastorage.googleapis.com/chromium-browser-clang';
function getPlatformUrlPrefix(hostOS) {
    const prefixMap = {
        'linux': 'Linux_x64',
        'darwin': 'Mac',
        'win32': 'Win',
    };
    return CDS_URL + '/' + prefixMap[hostOS] + '/';
}
function getClangDownloadURL(packageFile, packageVersion, hostOS) {
    const cdsFile = `${packageFile}-${packageVersion}.tgz`;
    return getPlatformUrlPrefix(hostOS) + cdsFile;
}
function getSDKRoot() {
    if (process.env.SDKROOT)
        return process.env.SDKROOT;
    const output = cp.execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
    return output.toString().trim();
}
function getClangEnvironmentVars(electronVersion) {
    const clangDir = path.resolve(constants_1.ELECTRON_GYP_DIR, `${electronVersion}-clang`, 'bin');
    const clangArgs = [];
    if (process.platform === 'darwin') {
        clangArgs.push('-isysroot', getSDKRoot());
    }
    const gypArgs = [];
    if (process.platform === 'win32') {
        console.log(fs.readdirSync(clangDir));
        gypArgs.push(`/p:CLToolExe=clang-cl.exe`, `/p:CLToolPath=${clangDir}`);
    }
    return {
        env: {
            CC: `"${path.resolve(clangDir, 'clang')}" ${clangArgs.join(' ')}`,
            CXX: `"${path.resolve(clangDir, 'clang++')}" ${clangArgs.join(' ')}`,
        },
        args: gypArgs,
    };
}
exports.getClangEnvironmentVars = getClangEnvironmentVars;
function clangVersionFromRevision(update) {
    const regex = /CLANG_REVISION = '([^']+)'\nCLANG_SUB_REVISION = (\d+)\n/g;
    const clangVersionMatch = regex.exec(update);
    if (!clangVersionMatch)
        return null;
    const [, clangVersion, clangSubRevision] = clangVersionMatch;
    return `${clangVersion}-${clangSubRevision}`;
}
function clangVersionFromSVN(update) {
    const regex = /CLANG_REVISION = '([^']+)'\nCLANG_SVN_REVISION = '([^']+)'\nCLANG_SUB_REVISION = (\d+)\n/g;
    const clangVersionMatch = regex.exec(update);
    if (!clangVersionMatch)
        return null;
    const [, clangVersion, clangSvn, clangSubRevision] = clangVersionMatch;
    return `${clangSvn}-${clangVersion.substr(0, 8)}-${clangSubRevision}`;
}
async function downloadClangVersion(electronVersion) {
    d('fetching clang for Electron:', electronVersion);
    const clangDirPath = path.resolve(constants_1.ELECTRON_GYP_DIR, `${electronVersion}-clang`);
    if (await fs.pathExists(path.resolve(clangDirPath, 'bin', 'clang')))
        return;
    if (!await fs.pathExists(constants_1.ELECTRON_GYP_DIR))
        await fs.mkdirp(constants_1.ELECTRON_GYP_DIR);
    const electronDeps = await fetch(`https://raw.githubusercontent.com/electron/electron/v${electronVersion}/DEPS`, 'text');
    const chromiumRevisionExtractor = /'chromium_version':\n\s+'([^']+)/g;
    const chromiumRevisionMatch = chromiumRevisionExtractor.exec(electronDeps);
    if (!chromiumRevisionMatch)
        throw new Error('Failed to determine Chromium revision for given Electron version');
    const chromiumRevision = chromiumRevisionMatch[1];
    d('fetching clang for Chromium:', chromiumRevision);
    const base64ClangUpdate = await fetch(`https://chromium.googlesource.com/chromium/src.git/+/${chromiumRevision}/tools/clang/scripts/update.py?format=TEXT`, 'text');
    const clangUpdate = Buffer.from(base64ClangUpdate, 'base64').toString('utf8');
    const clangVersionString = clangVersionFromRevision(clangUpdate) || clangVersionFromSVN(clangUpdate);
    if (!clangVersionString)
        throw new Error('Failed to determine Clang revision from Electron version');
    d('fetching clang:', clangVersionString);
    const clangDownloadURL = getClangDownloadURL('clang', clangVersionString, process.platform);
    const contents = await fetch(clangDownloadURL, 'buffer');
    d('deflating clang');
    zlib.deflateSync(contents);
    const tarPath = path.resolve(constants_1.ELECTRON_GYP_DIR, `${electronVersion}-clang.tar`);
    if (await fs.pathExists(tarPath))
        await fs.remove(tarPath);
    await fs.writeFile(tarPath, Buffer.from(contents));
    await fs.mkdirp(clangDirPath);
    d('tar running on clang');
    await tar.x({
        file: tarPath,
        cwd: clangDirPath,
    });
    await fs.remove(tarPath);
    d('cleaning up clang tar file');
}
exports.downloadClangVersion = downloadClangVersion;
