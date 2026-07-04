import * as memFile from "./memfile.js";
import * as bigMemFile from "./bigmemfile.js";

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

async function fetchAsMemOpts(url) {
    const ab = await fetch(url).then(r => r.arrayBuffer());
    return { type: "mem", data: new Uint8Array(ab) };
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

export async function readExisting(o) {
    o = typeof o === "string" ? await fetchAsMemOpts(o) : normalizeOpts(o);
    return dispatchMem(o, memFile.readExisting, bigMemFile.readExisting);
}

export function readWriteExisting(o) {
    if (typeof o === "string") noFileSupport();
    return dispatchMem(o, memFile.readWriteExisting, bigMemFile.readWriteExisting);
}

export const readWriteExistingOrCreate = readWriteExisting;
