import * as memFile from "./memfile.js";
import * as bigMemFile from "./bigmemfile.js";
import * as httpFile from "./httpfile.js";
import * as blobFile from "./blobfile.js";

function noFileSupport() {
    throw new Error("File I/O is not supported in the browser");
}

function normalizeOpts(o) {
    if (o instanceof Uint8Array) return { type: "mem", data: o };
    // A string means a file path/name in the Node API. There are no files in
    // the browser, so reject it instead of silently creating an anonymous mem
    // file (which would mask code copied from the Node README).
    if (typeof o === "string") noFileSupport();
    return o;
}

function dispatchMem(o, memFn, bigMemFn) {
    if (o.type === "file") noFileSupport();
    if (o.type === "mem") return memFn(o);
    if (o.type === "bigMem") return bigMemFn(o);
    throw new Error("Invalid FastFile type: " + o.type);
}

export function createOverride(o) {
    return dispatchMem(normalizeOpts(o), memFile.createNew, bigMemFile.createNew);
}

export const createNoOverride = createOverride;

export async function readExisting(o, b, c) {
    if (o instanceof Uint8Array) {
        o = { type: "mem", data: o };
    }
    if (typeof Blob !== "undefined" && o instanceof Blob) {
        o = { type: "blob", blob: o, cacheSize: b, pageSize: c };
    }
    if (typeof o === "string") {
        // URLs (historically fetched whole) go through the http backend: it
        // streams via Range requests when the server supports them and falls
        // back to buffering the full body when it does not.
        o = { type: "http", url: o, cacheSize: b, pageSize: c };
    }
    if (o.type === "http") return await httpFile.readExisting(o);
    if (o.type === "blob") return blobFile.readExisting(o);
    return dispatchMem(o, memFile.readExisting, bigMemFile.readExisting);
}

export function readWriteExisting(o) {
    if (typeof o === "string") noFileSupport();
    return dispatchMem(o, memFile.readWriteExisting, bigMemFile.readWriteExisting);
}

export const readWriteExistingOrCreate = readWriteExisting;
