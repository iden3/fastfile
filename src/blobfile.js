// Read-only file over a Blob/File (e.g. a browser <input type="file">
// selection). blob.slice() is a zero-copy view; bytes only reach memory when
// a sub-range is read, so large zkeys stream from disk chunk-by-chunk with
// the same bounded footprint as the Node file backend.

import { RangeFile } from "./rangefile.js";

export function readExisting(o) {
    const blob = o.blob;
    const readRangeInto = async function (dst, dstOffset, pos, len) {
        const ab = await blob.slice(pos, pos + len).arrayBuffer();
        if (ab.byteLength !== len) {
            throw new Error("short blob read (" + ab.byteLength + "/" + len + " bytes at " + pos + ")");
        }
        dst.set(new Uint8Array(ab), dstOffset);
    };
    return new RangeFile(readRangeInto, blob.size, o.cacheSize, o.pageSize);
}
