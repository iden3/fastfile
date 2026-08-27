import { open } from "./osfile.js";
import * as memFile from "./memfile.js";
import * as bigMemFile from "./bigmemfile.js";
import * as httpFile from "./httpfile.js";
import * as blobFile from "./blobfile.js";
import { O_TRUNC, O_CREAT, O_RDWR, O_EXCL, O_RDONLY } from "constants";


const DEFAULT_CACHE_SIZE = (1 << 16);
const DEFAULT_PAGE_SIZE = (1 << 13);

// Robust Node detection that never throws (unlike `process.browser`, which is a
// webpack-ism and is undefined under Vite/esbuild/SES).
const isNode = typeof process !== "undefined" && process.versions != null && process.versions.node != null;


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
    if (typeof Blob !== "undefined" && o instanceof Blob) {
        o = {
            type: "blob",
            blob: o,
            cacheSize: b,
            pageSize: c
        };
    }
    if (typeof o === "string") {
        // URLs (and, in the browser, any string -- historically fetched
        // whole) go through the http backend: it streams via Range requests
        // when the server supports them and falls back to buffering the
        // full body (the previous behavior) when it does not.
        if (!isNode || /^https?:\/\//i.test(o)) {
            o = {
                type: "http",
                url: o,
                cacheSize: b,
                pageSize: c
            };
        } else {
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
    } else if (o.type == "http") {
        return await httpFile.readExisting(o);
    } else if (o.type == "blob") {
        return blobFile.readExisting(o);
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
