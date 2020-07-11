import { open } from "./osfile.js";
import * as memFile from "./memfile.js";


export async function createOverride(o, b) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b
        };
    }
    if (o.type == "file") {
        return await open(o.fileName, "w+", o.cacheSize);
    } else if (o.type == "mem") {
        return memFile.createNew(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

export function createNoOverride(o, b) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b
        };
    }
    if (o.type == "file") {
        return open(o.fileName, "wx+", o.cacheSize);
    } else if (o.type == "mem") {
        return memFile.createNew(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

export function readExisting(o, b) {
    if (o instanceof Uint8Array) {
        o = {
            type: "mem",
            data: o
        };
    }
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b
        };
    }
    if (o.type == "file") {
        return open(o.fileName, "r", o.cacheSize);
    } else if (o.type == "mem") {
        return memFile.readExisting(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

export function readWriteExisting(o, b) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b
        };
    }
    if (o.type == "file") {
        return open(o.fileName, "a+", o.cacheSize);
    } else if (o.type == "mem") {
        return memFile.readWriteExisting(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

export function readWriteExistingOrCreate(o, b) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b
        };
    }
    if (o.type == "file") {
        return open(o.fileName, "ax+", o.cacheSize);
    } else if (o.type == "mem") {
        return memFile.readWriteExisting(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}
