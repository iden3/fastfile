import * as memFile from "./memfile.js";
import * as bigMemFile from "./bigmemfile.js";

const DEFAULT_CACHE_SIZE = 1 << 16;

function noFileSupport() {
    throw new Error("File I/O is not supported in the browser");
}

function normalizeOpts(o, initialSize) {
    if (o instanceof Uint8Array) return { type: "mem", data: o };
    if (typeof o !== "string") return o;
    return { type: "mem", initialSize: initialSize || DEFAULT_CACHE_SIZE };
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

export function createOverride(o, b) {
    return dispatchMem(normalizeOpts(o, b), memFile.createNew, bigMemFile.createNew);
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
