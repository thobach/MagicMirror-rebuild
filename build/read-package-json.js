"use strict";
exports.readPackageJson = void 0;
const fs = require("fs-extra");
const path = require("path");

async function readPackageJson(dir, safe = false) {
    try {
        return await fs.readJson(path.resolve(dir, 'package.json'));
    }
    catch (err) {
        if (safe) {
            return {};
        }
        else {
            throw err;
        }
    }
}
exports.readPackageJson = readPackageJson;
