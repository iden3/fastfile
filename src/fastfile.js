import { open } from "./osfile.js";
import * as memFile from "./memfile.js";
import * as bigMemFile from "./bigmemfile.js";
import { O_TRUNC, O_CREAT, O_RDWR, O_EXCL, O_RDONLY } from "constants";

const DEFAULT_CACHE_SIZE = 1 << 16;
const DEFAULT_PAGE_SIZE = 1 << 13;

function normalizeOpts(o, cacheSize, pageSize) {
    if (typeof o !== "string") return o;
    return {
        type: "file",
        fileName: o,
        cacheSize: cacheSize || DEFAULT_CACHE_SIZE,
        pageSize: pageSize || DEFAULT_PAGE_SIZE,
    };
}

function invalidType(type) {
    throw new Error("Invalid FastFile type: " + type);
}

export function createOverride(o, b, c) {
    o = normalizeOpts(o, b, c);
    if (o.type === "file") return open(o.fileName, O_TRUNC | O_CREAT | O_RDWR, o.cacheSize, o.pageSize);
    if (o.type === "mem") return memFile.createNew(o);
    if (o.type === "bigMem") return bigMemFile.createNew(o);
    invalidType(o.type);
}

export function createNoOverride(o, b, c) {
    o = normalizeOpts(o, b, c);
    if (o.type === "file") return open(o.fileName, O_TRUNC | O_CREAT | O_RDWR | O_EXCL, o.cacheSize, o.pageSize);
    if (o.type === "mem") return memFile.createNew(o);
    if (o.type === "bigMem") return bigMemFile.createNew(o);
    invalidType(o.type);
}

export async function readExisting(o, b, c) {
    if (o instanceof Uint8Array) o = { type: "mem", data: o };
    o = normalizeOpts(o, b, c);
    if (o.type === "file") return open(o.fileName, O_RDONLY, o.cacheSize, o.pageSize);
    if (o.type === "mem") return memFile.readExisting(o);
    if (o.type === "bigMem") return bigMemFile.readExisting(o);
    invalidType(o.type);
}

export function readWriteExisting(o, b, c) {
    o = normalizeOpts(o, b, c);
    if (o.type === "file") return open(o.fileName, O_CREAT | O_RDWR, o.cacheSize, o.pageSize);
    if (o.type === "mem") return memFile.readWriteExisting(o);
    if (o.type === "bigMem") return bigMemFile.readWriteExisting(o);
    invalidType(o.type);
}

export function readWriteExistingOrCreate(o, b, c) {
    o = normalizeOpts(o, b, c);
    if (o.type === "file") return open(o.fileName, O_CREAT | O_RDWR | O_EXCL, o.cacheSize);
    if (o.type === "mem") return memFile.readWriteExisting(o);
    if (o.type === "bigMem") return bigMemFile.readWriteExisting(o);
    invalidType(o.type);
}
