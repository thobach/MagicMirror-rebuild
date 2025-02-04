"use strict";
exports.rebuildNativeModules = exports.rebuild = exports.createOptions = exports.Rebuilder = void 0;
const crypto = require("crypto");
const debug = require("debug");
const events_1 = require("events");
const fs = require("fs-extra");
const nodeAbi = require("node-abi");
const os = require("os");
const path = require("path");
const read_package_json_1 = require("./read-package-json");
const cache_1 = require("./cache");
const search_module_1 = require("./search-module");
const d = debug('electron-rebuild');
const defaultMode = 'sequential';
const defaultTypes = ['prod', 'optional'];
// Update this number if you change the caching logic to ensure no bad cache hits
const ELECTRON_REBUILD_CACHE_ID = 1;
class Rebuilder {
    constructor(options) {
        this.hashDirectory = async (dir, relativeTo = dir) => {
            d('hashing dir', dir);
            const dirTree = {};
            await Promise.all((await fs.readdir(dir)).map(async (child) => {
                d('found child', child, 'in dir', dir);
                // Ignore output directories
                if (dir === relativeTo && (child === 'build' || child === 'bin'))
                    return;
                // Don't hash nested node_modules
                if (child === 'node_modules')
                    return;
                const childPath = path.resolve(dir, child);
                const relative = path.relative(relativeTo, childPath);
                if ((await fs.stat(childPath)).isDirectory()) {
                    dirTree[relative] = await this.hashDirectory(childPath, relativeTo);
                }
                else {
                    dirTree[relative] = crypto.createHash('SHA256').update(await fs.readFile(childPath)).digest('hex');
                }
            }));
            return dirTree;
        };
        this.dHashTree = (tree, hash) => {
            for (const key of Object.keys(tree).sort()) {
                hash.update(key);
                if (typeof tree[key] === 'string') {
                    hash.update(tree[key]);
                }
                else {
                    this.dHashTree(tree[key], hash);
                }
            }
        };
        this.generateCacheKey = async (opts) => {
            const tree = await this.hashDirectory(opts.modulePath);
            const hasher = crypto.createHash('SHA256')
                .update(`${ELECTRON_REBUILD_CACHE_ID}`)
                .update(path.basename(opts.modulePath))
                .update(this.ABI)
                .update(this.arch)
                .update(this.debug ? 'debug' : 'not debug')
                .update(this.headerURL)
                .update(this.electronVersion);
            this.dHashTree(tree, hasher);
            const hash = hasher.digest('hex');
            d('calculated hash of', opts.modulePath, 'to be', hash);
            return hash;
        };
        this.lifecycle = options.lifecycle;
        this.buildPath = options.buildPath;
        this.electronVersion = options.electronVersion;
        this.arch = options.arch || process.arch;
        this.extraModules = options.extraModules || [];
        this.onlyModules = options.onlyModules || null;
        this.force = options.force || false;
        this.headerURL = options.headerURL || 'https://www.electronjs.org/headers';
        this.types = options.types || defaultTypes;
        this.mode = options.mode || defaultMode;
        this.debug = options.debug || false;
        this.useCache = options.useCache || false;
        this.useElectronClang = options.useElectronClang || false;
        this.cachePath = options.cachePath || path.resolve(os.homedir(), '.electron-rebuild-cache');
        this.prebuildTagPrefix = options.prebuildTagPrefix || 'v';
        this.msvsVersion = process.env.GYP_MSVS_VERSION;
        if (this.useCache && this.force) {
            console.warn('[WARNING]: Electron Rebuild has force enabled and cache enabled, force take precedence and the cache will not be used.');
            this.useCache = false;
        }
        this.projectRootPath = options.projectRootPath;
        if (typeof this.electronVersion === 'number') {
            if (`${this.electronVersion}`.split('.').length === 1) {
                this.electronVersion = `${this.electronVersion}.0.0`;
            }
            else {
                this.electronVersion = `${this.electronVersion}.0`;
            }
        }
        if (typeof this.electronVersion !== 'string') {
            throw new Error(`Expected a string version for electron version, got a "${typeof this.electronVersion}"`);
        }
        this.ABI = options.forceABI || nodeAbi.getAbi(this.electronVersion, 'electron');
        this.prodDeps = this.extraModules.reduce((acc, x) => acc.add(x), new Set());
        this.rebuilds = [];
        this.realModulePaths = new Set();
        this.realNodeModulesPaths = new Set();
    }
    async rebuild() {
        if (!path.isAbsolute(this.buildPath)) {
            throw new Error('Expected buildPath to be an absolute path');
        }
        d('rebuilding with args:', this.buildPath, this.electronVersion, this.arch, this.extraModules, this.force, this.headerURL, this.types, this.debug);
        this.lifecycle.emit('start');
        const rootPackageJson = await (0, read_package_json_1.readPackageJson)(this.buildPath);
        const markWaiters = [];
        const depKeys = [];
        if (this.types.indexOf('prod') !== -1 || this.onlyModules) {
            depKeys.push(...Object.keys(rootPackageJson.dependencies || {}));
        }
        if (this.types.indexOf('optional') !== -1 || this.onlyModules) {
            depKeys.push(...Object.keys(rootPackageJson.optionalDependencies || {}));
        }
        if (this.types.indexOf('dev') !== -1 || this.onlyModules) {
            depKeys.push(...Object.keys(rootPackageJson.devDependencies || {}));
        }
        for (const key of depKeys) {
            this.prodDeps[key] = true;
            const modulePaths = await (0, search_module_1.searchForModule)(this.buildPath, key, this.projectRootPath);
            for (const modulePath of modulePaths) {
                markWaiters.push(this.markChildrenAsProdDeps(modulePath));
            }
        }
        await Promise.all(markWaiters);
        d('identified prod deps:', this.prodDeps);
        const nodeModulesPaths = await (0, search_module_1.searchForNodeModules)(this.buildPath, this.projectRootPath);
        for (const nodeModulesPath of nodeModulesPaths) {
            await this.rebuildAllModulesIn(nodeModulesPath);
        }
        this.rebuilds.push(() => this.rebuildModuleAt(this.buildPath));
        if (this.mode !== 'sequential') {
            await Promise.all(this.rebuilds.map(fn => fn()));
        }
        else {
            for (const rebuildFn of this.rebuilds) {
                await rebuildFn();
            }
        }
    }
    async rebuildModuleAt(modulePath) {
        if (!(await fs.pathExists(path.resolve(modulePath, 'binding.gyp')))) {
            return;
        }
        const { ModuleRebuilder } = require('./module-rebuilder');
        const moduleRebuilder = new ModuleRebuilder(this, modulePath);
        this.lifecycle.emit('module-found', path.basename(modulePath));
        if (!this.force && await moduleRebuilder.alreadyBuiltByRebuild()) {
            d(`skipping: ${path.basename(modulePath)} as it is already built`);
            this.lifecycle.emit('module-done');
            this.lifecycle.emit('module-skip');
            return;
        }
        if (await moduleRebuilder.prebuildNativeModuleExists(modulePath)) {
            d(`skipping: ${path.basename(modulePath)} as it was prebuilt`);
            return;
        }
        let cacheKey;
        if (this.useCache) {
            cacheKey = await this.generateCacheKey({
                modulePath,
            });
            const applyDiffFn = await (0, cache_1.lookupModuleState)(this.cachePath, cacheKey);
            if (typeof applyDiffFn === 'function') {
                await applyDiffFn(modulePath);
                this.lifecycle.emit('module-done');
                return;
            }
        }
        if (await moduleRebuilder.rebuildPrebuildModule(cacheKey)) {
            this.lifecycle.emit('module-done');
            return;
        }
        await moduleRebuilder.rebuildNodeGypModule(cacheKey);
        this.lifecycle.emit('module-done');
    }
    async rebuildAllModulesIn(nodeModulesPath, prefix = '') {
        // Some package managers use symbolic links when installing node modules
        // we need to be sure we've never tested the a package before by resolving
        // all symlinks in the path and testing against a set
        const realNodeModulesPath = await fs.realpath(nodeModulesPath);
        if (this.realNodeModulesPaths.has(realNodeModulesPath)) {
            return;
        }
        this.realNodeModulesPaths.add(realNodeModulesPath);
        d('scanning:', realNodeModulesPath);
        for (const modulePath of await fs.readdir(realNodeModulesPath)) {
            // Ignore the magical .bin directory
            if (modulePath === '.bin')
                continue;
            // Ensure that we don't mark modules as needing to be rebuilt more than once
            // by ignoring / resolving symlinks
            const realPath = await fs.realpath(path.resolve(nodeModulesPath, modulePath));
            if (this.realModulePaths.has(realPath)) {
                continue;
            }
            this.realModulePaths.add(realPath);
            if (this.prodDeps[`${prefix}${modulePath}`] && (!this.onlyModules || this.onlyModules.includes(modulePath))) {
                this.rebuilds.push(() => this.rebuildModuleAt(realPath));
            }
            if (modulePath.startsWith('@')) {
                await this.rebuildAllModulesIn(realPath, `${modulePath}/`);
            }
            if (await fs.pathExists(path.resolve(nodeModulesPath, modulePath, 'node_modules'))) {
                await this.rebuildAllModulesIn(path.resolve(realPath, 'node_modules'));
            }
        }
    }
    async findModule(moduleName, fromDir, foundFn) {
        const testPaths = await (0, search_module_1.searchForModule)(fromDir, moduleName, this.projectRootPath);
        const foundFns = testPaths.map(testPath => foundFn(testPath));
        return Promise.all(foundFns);
    }
    async markChildrenAsProdDeps(modulePath) {
        if (!await fs.pathExists(modulePath)) {
            return;
        }
        d('exploring', modulePath);
        let childPackageJson;
        try {
            childPackageJson = await (0, read_package_json_1.readPackageJson)(modulePath, true);
        }
        catch (err) {
            return;
        }
        const moduleWait = [];
        const callback = this.markChildrenAsProdDeps.bind(this);
        for (const key of Object.keys(childPackageJson.dependencies || {}).concat(Object.keys(childPackageJson.optionalDependencies || {}))) {
            if (this.prodDeps[key]) {
                continue;
            }
            this.prodDeps[key] = true;
            moduleWait.push(this.findModule(key, modulePath, callback));
        }
        await Promise.all(moduleWait);
    }
}
exports.Rebuilder = Rebuilder;
function rebuildWithOptions(options) {
    d('rebuilding with args:', arguments);
    const lifecycle = new events_1.EventEmitter();
    const rebuilderOptions = { ...options, lifecycle };
    const rebuilder = new Rebuilder(rebuilderOptions);
    const ret = rebuilder.rebuild();
    ret.lifecycle = lifecycle;
    return ret;
}
function createOptions(buildPath, electronVersion, arch, extraModules, force, headerURL, types, mode, onlyModules, debug) {
    return {
        buildPath,
        electronVersion,
        arch,
        extraModules,
        onlyModules,
        force,
        headerURL,
        types,
        mode,
        debug
    };
}
exports.createOptions = createOptions;

function doRebuild(options, ...args) {
    if (typeof options === 'object') {
        return rebuildWithOptions(options);
    }
    console.warn('You are using the deprecated electron-rebuild API, please switch to using the options object instead');
    return rebuildWithOptions(createOptions(options, ...args));
}
exports.rebuild = doRebuild;
function rebuildNativeModules(electronVersion, modulePath, whichModule = '', _headersDir = null, arch = process.arch, _command, _ignoreDevDeps = false, _ignoreOptDeps = false, _verbose = false) {
    if (path.basename(modulePath) === 'node_modules') {
        modulePath = path.dirname(modulePath);
    }
    d('rebuilding in:', modulePath);
    console.warn('You are using the old API, please read the new docs and update to the new API');
    return (0, exports.rebuild)(modulePath, electronVersion, arch, whichModule.split(','));
}
exports.rebuildNativeModules = rebuildNativeModules;
