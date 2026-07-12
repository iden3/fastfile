import * as fastFile from "../src/fastfile.js";

import http from "http";
import assert from "assert";
import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";

chai.use(chaiAsPromised);
const expect = chai.expect;

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
    const log = { requests: [], bytesServed: 0 };
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
    this.timeout(100000);

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
                .to.be.rejectedWith(/file changed/);
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
            await expect(fd.read(16, 992)).to.be.rejectedWith(/out of bounds/);
            await expect(fd.write(new Uint8Array(4), 0)).to.be.rejectedWith(/read only/);
            await expect(fd.writeULE32(1, 0)).to.be.rejectedWith(/read only/);
            await fd.close();
        } finally {
            await srv.close();
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
