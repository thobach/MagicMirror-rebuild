"use strict";
exports.ModuleRebuilder = exports.BuildType = void 0;
const debug = require("debug");
const detectLibc = require("detect-libc");
const fs = require("fs-extra");
const NodeGyp = require("node-gyp");
const path = require("path");
const cache_1 = require("./cache");
const util_1 = require("util");
const read_package_json_1 = require("./read-package-json");
const cross_spawn_promise_1 = require("@malept/cross-spawn-promise");
const constants_1 = require("./constants");
const clang_fetcher_1 = require("./clang-fetcher");
const d = debug('electron-rebuild');
const locateBinary = async (basePath, suffix) => {
    let parentPath = basePath;
    let testPath;
    while (testPath !== parentPath) {
        testPath = parentPath;
        const checkPath = path.resolve(testPath, suffix);
        if (await fs.pathExists(checkPath)) {
            return checkPath;
        }
        parentPath = path.resolve(testPath, '..');
    }
    return null;
};
async function locatePrebuild(modulePath) {
    return await locateBinary(modulePath, 'node_modules/prebuild-install/bin.js');
}
var BuildType;
(function (BuildType) {
    BuildType["Debug"] = "Debug";
    BuildType["Release"] = "Release";
})(BuildType = exports.BuildType || (exports.BuildType = {}));
class ModuleRebuilder {
    constructor(rebuilder, modulePath) {
        this.modulePath = modulePath;
        this.rebuilder = rebuilder;
    }
    get buildType() {
        return this.rebuilder.debug ? BuildType.Debug : BuildType.Release;
    }
    get metaPath() {
        return path.resolve(this.modulePath, 'build', this.buildType, '.forge-meta');
    }
    get metaData() {
        return `${this.rebuilder.arch}--${this.rebuilder.ABI}`;
    }
    get moduleName() {
        return path.basename(this.modulePath);
    }
    async alreadyBuiltByRebuild() {
        if (await fs.pathExists(this.metaPath)) {
            const meta = await fs.readFile(this.metaPath, 'utf8');
            return meta === this.metaData;
        }
        return false;
    }
    async buildNodeGypArgs(prefixedArgs) {
        const args = [
            'node',
            'node-gyp',
            'rebuild',
            ...prefixedArgs,
            `--runtime=electron`,
            `--target=${this.rebuilder.electronVersion}`,
            `--arch=${this.rebuilder.arch}`,
            `--dist-url=${this.rebuilder.headerURL}`,
            '--build-from-source',
            `--devdir="${constants_1.ELECTRON_GYP_DIR}"`
        ];
        if (process.env.DEBUG) {
            args.push('--verbose');
        }
        if (this.rebuilder.debug) {
            args.push('--debug');
        }
        args.push(...(await this.buildNodeGypArgsFromBinaryField()));
        if (this.rebuilder.msvsVersion) {
            args.push(`--msvs_version=${this.rebuilder.msvsVersion}`);
        }
        return args;
    }
    async buildNodeGypArgsFromBinaryField() {
        const binary = await this.packageJSONFieldWithDefault('binary', {});
        const flags = await Promise.all(Object.entries(binary).map(async ([binaryKey, binaryValue]) => {
            if (binaryKey === 'napi_versions') {
                return;
            }
            let value = binaryValue;
            if (binaryKey === 'module_path') {
                value = path.resolve(this.modulePath, value);
            }
            value = value.replace('{configuration}', this.buildType)
                .replace('{node_abi}', `electron-v${this.rebuilder.electronVersion.split('.').slice(0, 2).join('.')}`)
                .replace('{platform}', process.platform)
                .replace('{arch}', this.rebuilder.arch)
                .replace('{version}', await this.packageJSONField('version'))
                .replace('{libc}', detectLibc.family || 'unknown');
            for (const [replaceKey, replaceValue] of Object.entries(binary)) {
                value = value.replace(`{${replaceKey}}`, replaceValue);
            }
            return `--${binaryKey}=${value}`;
        }));
        return flags.filter(value => value);
    }
    async cacheModuleState(cacheKey) {
        if (this.rebuilder.useCache) {
            await (0, cache_1.cacheModuleState)(this.modulePath, this.rebuilder.cachePath, cacheKey);
        }
    }
    async isPrebuildNativeModule() {
        const dependencies = await this.packageJSONFieldWithDefault('dependencies', {});
        return !!dependencies['prebuild-install'];
    }
    async packageJSONFieldWithDefault(key, defaultValue) {
        const result = await this.packageJSONField(key);
        return result === undefined ? defaultValue : result;
    }
    async packageJSONField(key) {
        this.packageJSON || (this.packageJSON = await (0, read_package_json_1.readPackageJson)(this.modulePath));
        return this.packageJSON[key];
    }
    /**
     * Whether a prebuild-based native module exists.
     */
    async prebuildNativeModuleExists() {
        return fs.pathExists(path.resolve(this.modulePath, 'prebuilds', `${process.platform}-${this.rebuilder.arch}`, `electron-${this.rebuilder.ABI}.node`));
    }
    restoreEnv(env) {
        const gotKeys = new Set(Object.keys(process.env));
        const expectedKeys = new Set(Object.keys(env));
        for (const key of Object.keys(process.env)) {
            if (!expectedKeys.has(key)) {
                delete process.env[key];
            }
            else if (env[key] !== process.env[key]) {
                process.env[key] = env[key];
            }
        }
        for (const key of Object.keys(env)) {
            if (!gotKeys.has(key)) {
                process.env[key] = env[key];
            }
        }
    }
    async rebuildNodeGypModule(cacheKey) {
        if (this.modulePath.includes(' ')) {
            console.error('Attempting to build a module with a space in the path');
            console.error('See https://github.com/nodejs/node-gyp/issues/65#issuecomment-368820565 for reasons why this may not work');
            // FIXME: Re-enable the throw when more research has been done
            // throw new Error(`node-gyp does not support building modules with spaces in their path, tried to build: ${modulePath}`);
        }
        let env;
        const extraNodeGypArgs = [];
        if (this.rebuilder.useElectronClang) {
            env = { ...process.env };
            await (0, clang_fetcher_1.downloadClangVersion)(this.rebuilder.electronVersion);
            const { env: clangEnv, args: clangArgs } = (0, clang_fetcher_1.getClangEnvironmentVars)(this.rebuilder.electronVersion);
            Object.assign(process.env, clangEnv);
            extraNodeGypArgs.push(...clangArgs);
        }
        const nodeGypArgs = await this.buildNodeGypArgs(extraNodeGypArgs);
        d('rebuilding', this.moduleName, 'with args', nodeGypArgs);
        const nodeGyp = NodeGyp();
        nodeGyp.parseArgv(nodeGypArgs);
        let command = nodeGyp.todo.shift();
        const originalWorkingDir = process.cwd();
        try {
            process.chdir(this.modulePath);
            while (command) {
                if (command.name === 'configure') {
                    command.args = command.args.filter((arg) => !extraNodeGypArgs.includes(arg));
                }
                else if (command.name === 'build' && process.platform === 'win32') {
                    // This is disgusting but it prevents node-gyp from destroying our MSBuild arguments
                    command.args.map = (fn) => {
                        return Array.prototype.map.call(command.args, (arg) => {
                            if (arg.startsWith('/p:'))
                                return arg;
                            return fn(arg);
                        });
                    };
                }
                await (0, util_1.promisify)(nodeGyp.commands[command.name])(command.args);
                command = nodeGyp.todo.shift();
            }
        }
        catch (err) {
            let errorMessage = `node-gyp failed to rebuild '${this.modulePath}'.\n`;
            errorMessage += `Error: ${err.message || err}\n\n`;
            throw new Error(errorMessage);
        }
        finally {
            process.chdir(originalWorkingDir);
        }
        d('built:', this.moduleName);
        await this.writeMetadata();
        await this.replaceExistingNativeModule();
        await this.cacheModuleState(cacheKey);
        if (this.rebuilder.useElectronClang) {
            this.restoreEnv(env);
        }
    }
    async rebuildPrebuildModule(cacheKey) {
        if (!(await this.isPrebuildNativeModule())) {
            return false;
        }
        d(`assuming is prebuild powered: ${this.moduleName}`);
        const prebuildInstallPath = await locatePrebuild(this.modulePath);
        if (prebuildInstallPath) {
            d(`triggering prebuild download step: ${this.moduleName}`);
            let success = false;
            try {
                await this.runPrebuildInstall(prebuildInstallPath);
                success = true;
            }
            catch (err) {
                d('failed to use prebuild-install:', err);
            }
            if (success) {
                d('built:', this.moduleName);
                await this.writeMetadata();
                await this.cacheModuleState(cacheKey);
                return true;
            }
        }
        else {
            d(`could not find prebuild-install relative to: ${this.modulePath}`);
        }
        return false;
    }
    async replaceExistingNativeModule() {
        const buildLocation = path.resolve(this.modulePath, 'build', this.buildType);
        d('searching for .node file', buildLocation);
        const buildLocationFiles = await fs.readdir(buildLocation);
        d('testing files', buildLocationFiles);
        const nodeFile = buildLocationFiles.find((file) => file !== '.node' && file.endsWith('.node'));
        const nodePath = nodeFile ? path.resolve(buildLocation, nodeFile) : undefined;
        if (nodePath && await fs.pathExists(nodePath)) {
            d('found .node file', nodePath);
            const abiPath = path.resolve(this.modulePath, `bin/${process.platform}-${this.rebuilder.arch}-${this.rebuilder.ABI}`);
            d('copying to prebuilt place:', abiPath);
            await fs.ensureDir(abiPath);
            await fs.copy(nodePath, path.resolve(abiPath, `${this.moduleName}.node`));
        }
    }
    async runPrebuildInstall(prebuildInstallPath) {
        const shimExt = process.env.ELECTRON_REBUILD_TESTS ? 'ts' : 'js';
        const executable = process.env.ELECTRON_REBUILD_TESTS ? path.resolve(__dirname, '..', 'node_modules', '.bin', 'ts-node') : process.execPath;
        await (0, cross_spawn_promise_1.spawn)(executable, [
            path.resolve(__dirname, `prebuild-shim.${shimExt}`),
            prebuildInstallPath,
            `--arch=${this.rebuilder.arch}`,
            `--platform=${process.platform}`,
            '--runtime=electron',
            `--target=${this.rebuilder.electronVersion}`,
            `--tag-prefix=${this.rebuilder.prebuildTagPrefix}`
        ], {
            cwd: this.modulePath,
        });
    }
    async writeMetadata() {
        await fs.ensureDir(path.dirname(this.metaPath));
        await fs.writeFile(this.metaPath, this.metaData);
    }
}
exports.ModuleRebuilder = ModuleRebuilder;
