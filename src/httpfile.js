// Read-only file over HTTP(S) using Range requests.
//
// Open probes the server with `Range: bytes=0-0`:
//   - 206 + parseable Content-Range total -> a RangeFile whose reads become
//     range requests; large reads (zkey/ptau sections, MSM chunks) stream
//     the response body straight into the caller's buffer, so the full file
//     is never resident;
//   - anything else (200, no range support, unknown total) -> fall back to
//     buffering the body in memory, i.e. the historical browser behavior.
//
// Consistency: the validator captured at open (strong ETag, else
// Last-Modified) is sent as If-Range on every range request. If the remote
// file changes mid-read the server answers 200 instead of 206 and the read
// throws, rather than silently mixing chunks of two file versions.
//
// Server requirements (CORS deployments): allow the `Range` request header
// and expose `Content-Range` + `ETag`; serve zkeys without Content-Encoding
// (ranges address encoded bytes).

import { RangeFile } from "./rangefile.js";
import * as memFile from "./memfile.js";

// Callers tune cacheSize/pageSize for the disk backend (snarkjs passes 8 MiB
// pages); over HTTP a page that large turns a 4-byte header read into a
// megabytes-range request -- for files below the page size, the whole file in
// one response, defeating streaming. Cap pages at 64 KiB: big enough to
// coalesce a binfile section-table scan, small enough to stay incidental.
// Reads >= the page size bypass the cache entirely (RangeFile direct path),
// so large section/chunk reads are unaffected by the cap.
const MAX_HTTP_PAGE_SIZE = 1 << 16;

export async function readExisting(o) {
    const url = o.url;
    const probe = await fetch(url, { headers: { "Range": "bytes=0-0" } });

    if (probe.status === 206) {
        const contentRange = probe.headers.get("content-range");
        const m = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
        if (m) {
            const totalSize = parseInt(m[1]);
            // Drain the 1-byte probe body so the connection can be reused.
            await probe.arrayBuffer();
            const validator = strongValidator(probe);
            // Degrade-to-buffering escape hatch: a 206 probe answer can come
            // from an intermediary (browsers satisfy ranges out of their own
            // HTTP cache of a full 200), while the origin itself ignores
            // Range. When a later range request gets a 200 whose strong
            // validator still matches, the file is unchanged -- buffer that
            // full body once and serve every subsequent read from it.
            let fullBody = null;
            const readRangeInto = async function (dst, dstOffset, pos, len) {
                if (!fullBody) {
                    try {
                        return await httpReadRangeInto(url, validator, dst, dstOffset, pos, len);
                    } catch (err) {
                        if (!err || !err.degradeToFull) throw err;
                        fullBody = err.fullBodyPromise;
                    }
                }
                const data = await fullBody;
                if (pos + len > data.byteLength) {
                    throw new Error(url + ": read past the end of the buffered body");
                }
                dst.set(data.subarray(pos, pos + len), dstOffset);
            };
            const pageSize = Math.min(o.pageSize || MAX_HTTP_PAGE_SIZE, MAX_HTTP_PAGE_SIZE);
            return new RangeFile(readRangeInto, totalSize, o.cacheSize, pageSize);
        }
        // 206 but total size unknown (Content-Range: bytes 0-0/*): we cannot
        // do bounded positioned reads; refetch whole and buffer.
        await probe.arrayBuffer();
        return await readFullyToMem(url);
    }

    if (!probe.ok && probe.status !== 416) {
        throw new Error("HTTP " + probe.status + " fetching " + url);
    }

    if (probe.status === 416) {
        // Range not satisfiable -- only legitimate for an empty file.
        const contentRange = probe.headers.get("content-range");
        if (contentRange && /\/0\s*$/.test(contentRange)) {
            return memFile.readExisting({ type: "mem", data: new Uint8Array(0) });
        }
        return await readFullyToMem(url);
    }

    // 200: the server ignored Range and sent the whole file; reuse this body.
    const data = new Uint8Array(await probe.arrayBuffer());
    return memFile.readExisting({ type: "mem", data: data });
}

async function readFullyToMem(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status + " fetching " + url);
    const data = new Uint8Array(await res.arrayBuffer());
    return memFile.readExisting({ type: "mem", data: data });
}

// Only a strong validator is usable with If-Range (RFC 9110 §13.1.5): a weak
// ETag would make conditional range requests always fail on some servers.
function strongValidator(res) {
    const etag = res.headers.get("etag");
    if (etag && etag.indexOf("W/") !== 0) return etag;
    const lastModified = res.headers.get("last-modified");
    if (lastModified) return lastModified;
    return null;
}

async function httpReadRangeInto(url, validator, dst, dstOffset, pos, len) {
    const headers = { "Range": "bytes=" + pos + "-" + (pos + len - 1) };
    if (validator) headers["If-Range"] = validator;
    const res = await fetch(url, { headers: headers });
    if (res.status === 200) {
        // A 200 mid-session means the origin does not honor Range (the 206
        // probe answer may have come from a browser cache). If the strong
        // validator still matches -- or we never had one -- the file is
        // unchanged: hand the full body to the caller to degrade to
        // buffered mode. Only a changed validator is a hard error.
        const nowValidator = strongValidator(res);
        if (!validator || (nowValidator && nowValidator === validator)) {
            const degrade = new Error(url + ": origin ignored Range; degrading to full buffering");
            degrade.degradeToFull = true;
            degrade.fullBodyPromise = res.arrayBuffer().then((b) => new Uint8Array(b));
            throw degrade;
        }
        await abandonBody(res);
        throw new Error(url + ": file changed (or server stopped honoring Range) while reading");
    }
    if (res.status !== 206) {
        await abandonBody(res);
        throw new Error("HTTP " + res.status + " reading range " + pos + "+" + len + " of " + url);
    }
    const contentRange = res.headers.get("content-range");
    const m = contentRange ? /bytes\s+(\d+)-(\d+)\//.exec(contentRange) : null;
    if (m && parseInt(m[1]) !== pos) {
        await abandonBody(res);
        throw new Error(url + ": server returned range starting at " + m[1] + ", requested " + pos);
    }

    // Stream the body straight into the destination (typed array or
    // BigBuffer -- both expose .set(chunk, offset)); avoids materializing
    // a second full-size copy of large section reads.
    let done = 0;
    if (res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        for (;;) {
            const it = await reader.read();
            if (it.done) break;
            if (done + it.value.byteLength > len) {
                reader.cancel().catch(function () {});
                throw new Error(url + ": range response longer than requested");
            }
            dst.set(it.value, dstOffset + done);
            done += it.value.byteLength;
        }
    } else {
        // coverage: fetch implementations without a streaming body (older
        // browser polyfills); Node's undici always streams
        /* c8 ignore start */
        const buff = new Uint8Array(await res.arrayBuffer());
        if (buff.byteLength > len) throw new Error(url + ": range response longer than requested");
        dst.set(buff, dstOffset);
        done = buff.byteLength;
        /* c8 ignore stop */
    }
    if (done !== len) {
        throw new Error(url + ": short range response (" + done + "/" + len + " bytes at " + pos + ")");
    }
}

async function abandonBody(res) {
    try {
        if (res.body && typeof res.body.cancel === "function") await res.body.cancel();
        /* c8 ignore next -- non-streaming fetch polyfills only */
        else await res.arrayBuffer();
    } catch (e) { /* body teardown is best-effort */ }
}
