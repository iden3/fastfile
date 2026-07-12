// Read-only file over a Blob/File (e.g. a browser <input type="file">
// selection). blob.slice() is a zero-copy view; bytes only reach memory when
// a sub-range is read, so large zkeys stream from disk chunk-by-chunk with
// the same bounded footprint as the Node file backend.

import { RangeFile } from "./rangefile.js";

// Same rationale as httpfile's cap, relaxed for a local source: callers pass
// disk-tuned page sizes (MiBs) that would make every small header read
// materialize a huge slice; 1 MiB keeps that bounded while costing at most a
// handful of slice reads per file open.
const MAX_BLOB_PAGE_SIZE = 1 << 20;

export function readExisting(o) {
    const blob = o.blob;
    const readRangeInto = async function (dst, dstOffset, pos, len) {
        const ab = await blob.slice(pos, pos + len).arrayBuffer();
        if (ab.byteLength !== len) {
            throw new Error("short blob read (" + ab.byteLength + "/" + len + " bytes at " + pos + ")");
        }
        dst.set(new Uint8Array(ab), dstOffset);
    };
    const pageSize = Math.min(o.pageSize || MAX_BLOB_PAGE_SIZE, MAX_BLOB_PAGE_SIZE);
    return new RangeFile(readRangeInto, blob.size, o.cacheSize, pageSize);
}
