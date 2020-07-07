import { open } from "./osfile.js";
import * as memFile from "./memfile.js";


async function createOverride(o, b) {
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

function createNoOverride(o, b) {
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

function readExisting(o, b) {
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

function readWriteExisting(o, b) {
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

function readWriteExistingOrCreate(o, b) {
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

export default {
    createOverride,
    createNoOverride,
    readExisting,
    readWriteExisting,
    readWriteExistingOrCreate
};
