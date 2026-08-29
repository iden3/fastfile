import * as fastFile from "../src/fastfile.js";

import http from "http";
import assert from "assert";
import { expect } from "vitest";


// Deterministic pseudo-random content so failures are reproducible.
function makeData(n) {
    const data = new Uint8Array(n);
    let x = 0x12345678;
    for (let i = 0; i < n; i++) {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        data[i] = x & 0xFF;
    }
    return data;
}

// Minimal static server. opts:
//   ranges: false  -> ignore Range headers, always 200 full body
//   etag           -> served as ETag; If-Range mismatches answer 200 full
// state.data / state.etag may be swapped mid-test to simulate a changed file.
function startServer(state, opts) {
    opts = opts || {};
    const log = { requests: [], bytesServed: 0, maxResponse: 0 };
    const server = http.createServer(function (req, res) {
        const entry = { range: req.headers.range || null, ifRange: req.headers["if-range"] || null };
        log.requests.push(entry);
        const data = state.data;
        const headers = {};
        if (state.etag) headers["ETag"] = state.etag;

        const m = (opts.ranges !== false && req.headers.range) ?
            /^bytes=(\d+)-(\d+)$/.exec(req.headers.range) : null;
        const ifRangeOk = !req.headers["if-range"] || req.headers["if-range"] === state.etag;

        if (m && ifRangeOk) {
            const start = parseInt(m[1]);
            if (start >= data.length) {
                headers["Content-Range"] = "bytes */" + data.length;
                res.writeHead(416, headers);
                res.end();
                return;
            }
            const end = Math.min(parseInt(m[2]), data.length - 1);
            const body = Buffer.from(data.slice(start, end + 1));
            headers["Content-Range"] = "bytes " + start + "-" + end + "/" + data.length;
            headers["Content-Length"] = body.length;
            headers["Accept-Ranges"] = "bytes";
            res.writeHead(206, headers);
            log.bytesServed += body.length;
            log.maxResponse = Math.max(log.maxResponse, body.length);
            res.end(body);
        } else {
            const body = Buffer.from(data);
            headers["Content-Length"] = body.length;
            res.writeHead(200, headers);
            log.bytesServed += body.length;
            res.end(body);
        }
    });
    return new Promise(function (resolve) {
        server.listen(0, "127.0.0.1", function () {
            resolve({
                server: server,
                log: log,
                url: "http://127.0.0.1:" + server.address().port + "/data.bin",
                close: function () {
                    return new Promise(function (res2) { server.close(res2); });
                }
            });
        });
    });
}

describe("fastfile testing suite for httpfile", function () {

    describe("unstable connections (retry + stall timeout)", () => {
        let saved;
        beforeEach(async () => {
            const { httpRetryConfig } = await import("../src/httpfile.js");
            saved = { ...httpRetryConfig };
            httpRetryConfig.backoffMs = 10;
            httpRetryConfig.stallTimeoutMs = 250;
        });
        afterEach(async () => {
            const { httpRetryConfig } = await import("../src/httpfile.js");
            Object.assign(httpRetryConfig, saved);
        });

        // Minimal faulty range server: `plan` decides per zkey request.
        function faultyServer(data, plan) {
            let n = 0;
            const server = http.createServer((req, res) => {
                const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
                const start = m ? parseInt(m[1]) : 0;
                const end = m ? Math.min(parseInt(m[2]), data.length - 1) : data.length - 1;
                const isProbe = start === 0 && end === 0;
                const action = isProbe ? "ok" : plan(++n);
                if (action === "503") { res.writeHead(503); res.end(); return; }
                res.writeHead(action === "404" ? 404 : 206, {
                    "Content-Range": `bytes ${start}-${end}/${data.length}`,
                    "Content-Length": end - start + 1,
                    "ETag": "\"u1\"", "Accept-Ranges": "bytes",
                });
                if (action === "404") { res.end(); return; }
                const body = Buffer.from(data.slice(start, end + 1));
                if (action === "drop") {
                    res.write(body.subarray(0, Math.floor(body.length / 2)));
                    setTimeout(() => res.destroy(), 10);
                    return;
                }
                if (action === "stall") {
                    res.write(body.subarray(0, 16)); // then silence, socket open
                    return;
                }
                res.end(body);
            });
            return new Promise((r) => server.listen(0, "127.0.0.1", () => r({
                url: `http://127.0.0.1:${server.address().port}/f.bin`,
                attempts: () => n,
                close: () => new Promise((x) => { server.closeAllConnections(); server.close(x); }),
            })));
        }

        it("recovers from a mid-body connection drop", async () => {
            const data = makeData(1 << 18);
            const srv = await faultyServer(data, (n) => (n === 1 ? "drop" : "ok"));
            try {
                const fd = await fastFile.readExisting(srv.url);
                const got = await fd.read(200000, 1000);
                assert.deepStrictEqual(Buffer.from(got), Buffer.from(data.slice(1000, 201000)));
                await fd.close();
                assert.strictEqual(srv.attempts(), 2);
            } finally { await srv.close(); }
        });

        it("retries transient 503s but fails fast on 404", async () => {
            const data = makeData(1 << 17);
            const srv = await faultyServer(data, (n) => (n <= 2 ? "503" : "ok"));
            try {
                const fd = await fastFile.readExisting(srv.url);
                const got = await fd.read(65536, 0);
                assert.deepStrictEqual(Buffer.from(got), Buffer.from(data.slice(0, 65536)));
                await fd.close();
                assert.strictEqual(srv.attempts(), 3);
            } finally { await srv.close(); }

            const srv2 = await faultyServer(data, () => "404");
            try {
                const fd = await fastFile.readExisting(srv2.url);
                await expect(fd.read(65536, 0)).rejects.toThrow("HTTP 404");
                assert.strictEqual(srv2.attempts(), 1); // permanent: no retry
                await fd.close();
            } finally { await srv2.close(); }
        });

        it("aborts a stalled response and recovers on retry", async () => {
            const data = makeData(1 << 18);
            const srv = await faultyServer(data, (n) => (n === 1 ? "stall" : "ok"));
            try {
                const t0 = Date.now();
                const fd = await fastFile.readExisting(srv.url);
                const got = await fd.read(150000, 5000);
                assert.deepStrictEqual(Buffer.from(got), Buffer.from(data.slice(5000, 155000)));
                await fd.close();
                assert.strictEqual(srv.attempts(), 2);
                assert.ok(Date.now() - t0 < 5000, "stall was not bounded");
            } finally { await srv.close(); }
        });

        it("gives up after exhausting retries", async () => {
            const data = makeData(1 << 17);
            const srv = await faultyServer(data, () => "503");
            try {
                const fd = await fastFile.readExisting(srv.url);
                await expect(fd.read(65536, 0)).rejects.toThrow("HTTP 503");
                assert.strictEqual(srv.attempts(), 4); // 1 try + 3 retries
                await fd.close();
            } finally { await srv.close(); }
        });
    });

    it("caps concurrent range fetches below the browser connection limit", async () => {
        const data = makeData(1 << 20);
        let inFlight = 0, maxInFlight = 0;
        const fakeFetch = async (url, opts) => {
            const m = /bytes=(\d+)-(\d+)/.exec((opts && opts.headers && opts.headers["Range"]) || "");
            const from = m ? parseInt(m[1]) : 0;
            const to = m ? Math.min(parseInt(m[2]), data.length - 1) : data.length - 1;
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 20));
            inFlight--;
            return {
                ok: true, status: 206,
                headers: new Map([
                    ["content-range", `bytes ${from}-${to}/${data.length}`],
                    ["etag", "\"cap\""],
                ]),
                arrayBuffer: async () => data.slice(from, to + 1).buffer,
                body: null,
            };
        };
        fakeFetch.headersGet = true;
        const realFetch = globalThis.fetch;
        globalThis.fetch = (u, o) => fakeFetch(u, o).then((r) => ({ ...r, headers: { get: (k) => r.headers.get(k.toLowerCase()) } }));
        try {
            const fd = await fastFile.readExisting({ type: "http", url: "http://cap.example/f.bin" });
            const reads = [];
            for (let k = 0; k < 12; k++) reads.push(fd.read(70000, k * 80000)); // > pageSize: direct path
            await Promise.all(reads);
            await fd.close();
            assert.ok(maxInFlight <= 4, "expected <= 4 concurrent range fetches, saw " + maxInFlight);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it("http cache option is a no-op where IndexedDB does not exist (Node)", async () => {
        const data = makeData(1 << 18);
        const srv = await startServer({ data: data, etag: "\"v1\"" });
        try {
            const fd = await fastFile.readExisting({
                type: "http", url: srv.url, cache: true,
            });
            const got = await fd.read(64, 12345);
            assert.deepStrictEqual(Buffer.from(got), Buffer.from(data.slice(12345, 12345 + 64)));
            await fd.close();
        } finally {
            await srv.close();
        }
    });

    it("should read ranges without ever downloading the full file", async () => {
        const data = makeData(1 << 20);   // 1 MiB
        const srv = await startServer({ data: data, etag: "\"v1\"" });
        try {
            const fd = await fastFile.readExisting(srv.url);
            assert.strictEqual(fd.totalSize, data.length);

            // header-style small reads
            const head = await fd.read(4, 0);
            assert.deepStrictEqual([...head], [...data.slice(0, 4)]);
            const v = await fd.readULE32(4);
            assert.strictEqual(v, new DataView(data.buffer).getUint32(4, true));

            // large positioned read (direct path)
            const big = new Uint8Array(300000);
            await fd.readToBuffer(big, 0, big.length, 500000);
            assert.deepStrictEqual(Buffer.from(big), Buffer.from(data.slice(500000, 800000)));

            // scattered small reads (cached path), spanning a page boundary
            const ps = fd.pageSize;
            const cross = await fd.read(16, ps - 8);
            assert.deepStrictEqual(Buffer.from(cross), Buffer.from(data.slice(ps - 8, ps + 8)));

            await fd.close();

            // every request carried a Range header (no full-file GET) ...
            for (const r of srv.log.requests) assert.ok(r.range, "expected only range requests");
            // ... and far less than the file was transferred
            assert.ok(srv.log.bytesServed < data.length / 2,
                "served " + srv.log.bytesServed + " of " + data.length);
        } finally {
            await srv.close();
        }
    });

    it("should serve repeated small reads on one page from cache (single request)", async () => {
        const data = makeData(1 << 16);
        const srv = await startServer({ data: data, etag: "\"v1\"" });
        try {
            const fd = await fastFile.readExisting(srv.url);
            const before = srv.log.requests.length;
            await fd.read(4, 100);
            await fd.read(4, 200);
            await fd.readULE64(300);
            assert.strictEqual(srv.log.requests.length, before + 1);
            await fd.close();
        } finally {
            await srv.close();
        }
    });

    it("should read sequentially without explicit positions", async () => {
        const data = makeData(4096);
        const srv = await startServer({ data: data });
        try {
            const fd = await fastFile.readExisting(srv.url);
            const a = await fd.read(10);
            const b = await fd.read(10);
            assert.deepStrictEqual(Buffer.concat([Buffer.from(a), Buffer.from(b)]), Buffer.from(data.slice(0, 20)));
            assert.strictEqual(fd.pos, 20);
            await fd.close();
        } finally {
            await srv.close();
        }
    });

    it("should fall back to full buffering when the server ignores Range", async () => {
        const data = makeData(100000);
        const srv = await startServer({ data: data }, { ranges: false });
        try {
            const fd = await fastFile.readExisting(srv.url);
            assert.strictEqual(fd.totalSize, data.length);
            const all = await fd.read(data.length, 0);
            assert.deepStrictEqual(Buffer.from(all), Buffer.from(data));
            await fd.close();
            // the probe response body was reused: exactly one request
            assert.strictEqual(srv.log.requests.length, 1);
        } finally {
            await srv.close();
        }
    });

    it("should fail a read when the remote file changes mid-session (If-Range)", async () => {
        const state = { data: makeData(1 << 20), etag: "\"v1\"" };
        const srv = await startServer(state);
        try {
            const fd = await fastFile.readExisting(srv.url);
            const buff = new Uint8Array(1 << 16);
            await fd.readToBuffer(buff, 0, buff.length, 0);   // works on v1

            state.data = makeData(1 << 20).map(function (b) { return b ^ 0xFF; });
            state.etag = "\"v2\"";

            // direct (uncached) read must reject, not silently mix versions
            await expect(fd.readToBuffer(new Uint8Array(1 << 16), 0, 1 << 16, 1 << 17))
                .rejects.toThrow(/file changed/);
            await fd.close();
        } finally {
            await srv.close();
        }
    });

    it("should reject reads out of bounds and any write", async () => {
        const data = makeData(1000);
        const srv = await startServer({ data: data, etag: "\"v1\"" });
        try {
            const fd = await fastFile.readExisting(srv.url);
            await expect(fd.read(16, 992)).rejects.toThrow(/out of bounds/);
            await expect(fd.write(new Uint8Array(4), 0)).rejects.toThrow(/read only/);
            await expect(fd.writeULE32(1, 0)).rejects.toThrow(/read only/);
            await fd.close();
        } finally {
            await srv.close();
        }
    });

    it("should cap disk-tuned page-size hints (small read must not fetch the file)", async () => {
        const data = makeData(1 << 19);   // 512 KiB, well under an 8 MiB "page"
        const srv = await startServer({ data: data, etag: "\"v1\"" });
        try {
            // snarkjs-style hints: 32 MiB cache, 8 MiB pages (meant for disk)
            const fd = await fastFile.readExisting(srv.url, 1 << 25, 1 << 23);
            await fd.read(4, 0);
            await fd.readULE64(300000);
            assert.ok(srv.log.maxResponse <= 1 << 16,
                "largest response was " + srv.log.maxResponse + " bytes; page hint not capped");
            await fd.close();
        } finally {
            await srv.close();
        }
    });

    it("close() is idempotent on the http backend", async () => {
        const data = makeData(1 << 12);
        const srv = await startServer({ data: data, etag: "\"v1\"" });
        try {
            const fd = await fastFile.readExisting(srv.url);
            await fd.read(4, 0);
            await fd.close();
            await fd.close(); // second close: no-op, no throw
        } finally {
            await srv.close();
        }
    });

    it("degrades to full buffering when the origin stops honoring Range (matching validator)", async () => {
        // Browser scenario: the probe is answered 206 by an HTTP cache, but
        // the origin itself ignores Range and answers 200 with the same
        // strong ETag. Reads must succeed via buffered mode, not throw
        // "file changed".
        const data = makeData(1 << 18);
        let first = true;
        const server = http.createServer((req, res) => {
            if (first && req.headers.range === "bytes=0-0") {
                first = false;
                res.writeHead(206, {
                    "Content-Range": "bytes 0-0/" + data.length,
                    "Content-Length": 1,
                    "ETag": "\"stable\"",
                });
                return res.end(Buffer.from(data.slice(0, 1)));
            }
            res.writeHead(200, { "Content-Length": data.length, "ETag": "\"stable\"" });
            res.end(Buffer.from(data));
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const url = "http://127.0.0.1:" + server.address().port + "/data.bin";
        try {
            const fd = await fastFile.readExisting(url);
            assert.strictEqual(fd.totalSize, data.length);
            const head = await fd.read(8, 0);
            assert.deepStrictEqual([...head], [...data.slice(0, 8)]);
            const mid = await fd.read(1 << 12, 1 << 17);
            assert.deepStrictEqual([...mid], [...data.slice(1 << 17, (1 << 17) + (1 << 12))]);
            await fd.close();
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it("still fails hard when a mid-session 200 carries a different validator", async () => {
        const data = makeData(1 << 16);
        let first = true;
        const server = http.createServer((req, res) => {
            if (first && req.headers.range === "bytes=0-0") {
                first = false;
                res.writeHead(206, {
                    "Content-Range": "bytes 0-0/" + data.length,
                    "Content-Length": 1,
                    "ETag": "\"v1\"",
                });
                return res.end(Buffer.from(data.slice(0, 1)));
            }
            res.writeHead(200, { "Content-Length": data.length, "ETag": "\"v2\"" });
            res.end(Buffer.from(data));
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const url = "http://127.0.0.1:" + server.address().port + "/data.bin";
        try {
            const fd = await fastFile.readExisting(url);
            await expect(fd.read(64, 0)).rejects.toThrow(/file changed/);
            await fd.close();
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it("should read strings through the page cache", async () => {
        const data = makeData(9000);
        const msg = "hello_snarkjs";
        for (let i = 0; i < msg.length; i++) data[8000 + i] = msg.charCodeAt(i);
        data[8000 + msg.length] = 0;
        const srv = await startServer({ data: data, etag: "\"v1\"" });
        try {
            const fd = await fastFile.readExisting(srv.url);
            const str = await fd.readString(8000);
            assert.strictEqual(str, msg);
            assert.strictEqual(fd.pos, 8000 + msg.length + 1);
            await fd.close();
        } finally {
            await srv.close();
        }
    });
});
