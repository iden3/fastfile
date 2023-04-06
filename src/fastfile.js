/* global fetch */
import { open } from "./osfile.js";
import * as memFile from "./memfile.js";
import * as bigMemFile from "./bigmemfile.js";

// Avoid having to patch values provided by the `constants` package
// by just inlining the values directly. These should never change. :fingers_crossed:
// Taken from https://github.com/juliangruber/constants-browserify/blob/ab9e8bf4e03c9e21e250273129a618bc40eecae7/constants.json
const O_RDONLY = 0;
const O_RDWR = 2;
const O_CREAT = 512;
const O_TRUNC = 1024;
const O_EXCL = 2048;

const DEFAULT_CACHE_SIZE = (1 << 16);
const DEFAULT_PAGE_SIZE = (1 << 13);


export async function createOverride(o, b, c) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b || DEFAULT_CACHE_SIZE,
            pageSize: c || DEFAULT_PAGE_SIZE
        };
    }
    if (o.type == "file") {
        return await open(o.fileName, O_TRUNC | O_CREAT | O_RDWR, o.cacheSize, o.pageSize);
    } else if (o.type == "mem") {
        return memFile.createNew(o);
    } else if (o.type == "bigMem") {
        return bigMemFile.createNew(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

export function createNoOverride(o, b, c) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b || DEFAULT_CACHE_SIZE,
            pageSize: c || DEFAULT_PAGE_SIZE
        };
    }
    if (o.type == "file") {
        return open(o.fileName, O_TRUNC | O_CREAT | O_RDWR | O_EXCL, o.cacheSize, o.pageSize);
    } else if (o.type == "mem") {
        return memFile.createNew(o);
    } else if (o.type == "bigMem") {
        return bigMemFile.createNew(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

export async function readExisting(o, b, c) {
    if (o instanceof Uint8Array) {
        o = {
            type: "mem",
            data: o
        };
    }
    if (process.browser) {
        if (typeof o === "string") {
            const buff = await fetch(o).then( function(res) {
                return res.arrayBuffer();
            }).then(function (ab) {
                return new Uint8Array(ab);
            });
            o = {
                type: "mem",
                data: buff
            };
        }
    } else {
        if (typeof o === "string") {
            o = {
                type: "file",
                fileName: o,
                cacheSize: b || DEFAULT_CACHE_SIZE,
                pageSize: c || DEFAULT_PAGE_SIZE
            };
        }
    }
    if (o.type == "file") {
        return await open(o.fileName, O_RDONLY, o.cacheSize, o.pageSize);
    } else if (o.type == "mem") {
        return await memFile.readExisting(o);
    } else if (o.type == "bigMem") {
        return await bigMemFile.readExisting(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

export function readWriteExisting(o, b, c) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b || DEFAULT_CACHE_SIZE,
            pageSize: c || DEFAULT_PAGE_SIZE
        };
    }
    if (o.type == "file") {
        return open(o.fileName, O_CREAT | O_RDWR, o.cacheSize, o.pageSize);
    } else if (o.type == "mem") {
        return memFile.readWriteExisting(o);
    } else if (o.type == "bigMem") {
        return bigMemFile.readWriteExisting(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

export function readWriteExistingOrCreate(o, b, c) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b || DEFAULT_CACHE_SIZE,
            pageSize: c || DEFAULT_PAGE_SIZE
        };
    }
    if (o.type == "file") {
        return open(o.fileName, O_CREAT | O_RDWR | O_EXCL, o.cacheSize);
    } else if (o.type == "mem") {
        return memFile.readWriteExisting(o);
    } else if (o.type == "bigMem") {
        return bigMemFile.readWriteExisting(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}
