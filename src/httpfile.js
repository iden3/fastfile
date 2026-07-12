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
            const readRangeInto = function (dst, dstOffset, pos, len) {
                return httpReadRangeInto(url, validator, dst, dstOffset, pos, len);
            };
            return new RangeFile(readRangeInto, totalSize, o.cacheSize, o.pageSize);
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
        // With If-Range this is the server signalling the file changed;
        // without it, the server stopped honoring ranges mid-session.
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
        const buff = new Uint8Array(await res.arrayBuffer());
        if (buff.byteLength > len) throw new Error(url + ": range response longer than requested");
        dst.set(buff, dstOffset);
        done = buff.byteLength;
    }
    if (done !== len) {
        throw new Error(url + ": short range response (" + done + "/" + len + " bytes at " + pos + ")");
    }
}

async function abandonBody(res) {
    try {
        if (res.body && typeof res.body.cancel === "function") await res.body.cancel();
        else await res.arrayBuffer();
    } catch (e) { /* body teardown is best-effort */ }
}
