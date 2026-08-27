import fs from "fs";
import http from "http";
import * as fastFile from "../src/fastfile.js";

import assert from "assert";
import { expect } from "vitest";


// Behavioral coverage of the full FastFile API surface: the dispatcher
// variants in fastfile.js, and the ULE/UBE/string helpers plus error paths
// of every backend (mem, bigMem, os, http/range, blob).

const BIGMEM_PAGE = 1 << 22; // bigmemfile's fixed page size

function makeData(n) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = (i * 7 + 3) & 0xFF;
    return data;
}

// Round-trips every numeric helper plus a string on a writable fd.
async function roundTripHelpers(fd) {
    await fd.writeULE32(0x01020304, 0);
    await fd.writeUBE32(0x0A0B0C0D, 4);
    await fd.writeULE64(0x1FFFFFFFFF, 8); // > 2^32: exercises the high word

    assert.strictEqual(await fd.readULE32(0), 0x01020304);
    assert.strictEqual(await fd.readUBE32(4), 0x0A0B0C0D);
    assert.strictEqual(await fd.readULE64(8), 0x1FFFFFFFFF);

    // byte-level check of endianness
    const raw = await fd.read(8, 0);
    assert.deepStrictEqual([...raw], [4, 3, 2, 1, 0x0A, 0x0B, 0x0C, 0x0D]);
}

describe("fastfile API surface", function () {

    describe("dispatcher (fastfile.js)", function () {
        it("createOverride / createNoOverride / readWriteExisting reject unknown types", async () => {
            await expect(fastFile.createOverride({ type: "nope" })).rejects.toThrow("Invalid FastFile type");
            expect(() => fastFile.createNoOverride({ type: "nope" })).to.throw("Invalid FastFile type");
            await expect(fastFile.readExisting({ type: "nope" })).rejects.toThrow("Invalid FastFile type");
            expect(() => fastFile.readWriteExisting({ type: "nope" })).to.throw("Invalid FastFile type");
            expect(() => fastFile.readWriteExistingOrCreate({ type: "nope" })).to.throw("Invalid FastFile type");
        });

        it("createNoOverride creates mem/bigMem files and a fresh os file, but refuses an existing one", async () => {
            const mem = fastFile.createNoOverride({ type: "mem" });
            await mem.write(new Uint8Array([1, 2]), 0);
            mem.close();

            const big = fastFile.createNoOverride({ type: "bigMem" });
            await big.write(new Uint8Array([1, 2]), 0);
            big.close();

            const fileName = "test_no_override.bin";
            const fd = await fastFile.createNoOverride(fileName);
            await fd.write(new Uint8Array([9]), 0);
            await fd.close();
            // O_EXCL: a second createNoOverride on the same path must fail
            await expect(fastFile.createNoOverride(fileName)).rejects.toThrow();
            await fs.promises.unlink(fileName);
        });

        it("readWriteExisting opens mem, bigMem and os files for update", async () => {
            const memData = { type: "mem", data: makeData(16) };
            const mem = fastFile.readWriteExisting(memData);
            await mem.write(new Uint8Array([0xFF]), 0);
            assert.strictEqual((await mem.read(1, 0))[0], 0xFF);
            mem.close();

            const big = fastFile.readWriteExisting({ type: "bigMem", data: [makeData(16)] });
            await big.write(new Uint8Array([0xEE]), 0);
            assert.strictEqual((await big.read(1, 0))[0], 0xEE);
            big.close();

            const fileName = "test_rw_existing.bin";
            await fs.promises.writeFile(fileName, Buffer.from(makeData(32)));
            const fd = await fastFile.readWriteExisting(fileName);
            await fd.write(new Uint8Array([0xAB]), 0);
            assert.strictEqual((await fd.read(1, 0))[0], 0xAB);
            await fd.close();
            await fs.promises.unlink(fileName);
        });

        it("readWriteExistingOrCreate creates a fresh os file and opens mem/bigMem", async () => {
            const fileName = "test_rw_or_create.bin";
            const fd = await fastFile.readWriteExistingOrCreate(fileName);
            await fd.write(new Uint8Array([1, 2, 3]), 0);
            await fd.close();
            assert.strictEqual((await fs.promises.stat(fileName)).size, 3);
            await fs.promises.unlink(fileName);

            const mem = fastFile.readWriteExistingOrCreate({ type: "mem", data: makeData(4) });
            assert.strictEqual(mem.totalSize, 4);
            mem.close();

            const big = fastFile.readWriteExistingOrCreate({ type: "bigMem", data: [makeData(4)] });
            assert.strictEqual(big.totalSize, 4);
            big.close();
        });

        it("readExisting accepts a bare Uint8Array and a bigMem descriptor", async () => {
            const data = makeData(8);
            const fd = await fastFile.readExisting(data);
            assert.deepStrictEqual([...(await fd.read(8, 0))], [...data]);
            fd.close();

            const big = await fastFile.readExisting({ type: "bigMem", data: [makeData(8)] });
            assert.strictEqual(big.totalSize, 8);
            assert.strictEqual(big.readOnly, true);
            big.close();
        });
    });

    describe("mem backend", function () {
        it("round-trips the numeric helpers", async () => {
            const fd = await fastFile.createOverride({ type: "mem" });
            await roundTripHelpers(fd);
            fd.close();
        });

        it("grows the allocation when writing beyond it, and trims on close", async () => {
            const o = { type: "mem", initialSize: 4 };
            const fd = await fastFile.createOverride(o);
            const big = makeData(1 << 21); // 2 MiB: beyond the 1 MiB growth step
            await fd.write(big, 0);
            assert.strictEqual(fd.totalSize, big.byteLength);
            fd.close();
            assert.strictEqual(o.data.byteLength, big.byteLength);
            // a second close finds byteLength == totalSize and does not re-trim
            fd.close();
        });

        it("readToBuffer beyond the end grows a writable file but rejects on a read-only one", async () => {
            const rw = fastFile.readWriteExisting({ type: "mem", data: makeData(4) });
            const got = await rw.read(8, 0); // grows to 8; tail is zero-filled
            assert.deepStrictEqual([...got.slice(4)], [0, 0, 0, 0]);

            const ro = await fastFile.readExisting({ type: "mem", data: makeData(4) });
            await expect(ro.read(8, 0)).rejects.toThrow("Reading out of bounds");
            await expect(ro.write(new Uint8Array(1), 0)).rejects.toThrow("read only");
        });

        it("readString finds terminated strings and returns empty when unterminated", async () => {
            const enc = new TextEncoder();
            const fd = await fastFile.createOverride({ type: "mem" });
            await fd.write(enc.encode("hello"), 0);
            await fd.write(new Uint8Array([0]), 5);
            await fd.write(enc.encode("tail"), 6); // no terminator

            assert.strictEqual(await fd.readString(0), "hello");
            // sequential read continues after the terminator: unterminated tail
            const tail = await fd.readString();
            assert.strictEqual(tail, "");

            // read-only fd: reading a string past the end rejects
            const ro = await fastFile.readExisting({ type: "mem", data: enc.encode("x") });
            await expect(ro.readString(10)).rejects.toThrow("Reading out of bounds");

            // writable fd: a position past the end resizes and yields ""
            assert.strictEqual(await fd.readString(1000), "");

            await fd.discard();
            fd.close();
        });
    });

    describe("bigMem backend", function () {
        it("preallocates pages for initialSize and round-trips the numeric helpers", async () => {
            const fd = await fastFile.createOverride({ type: "bigMem", initialSize: BIGMEM_PAGE + 10 });
            assert.strictEqual(fd.o.data.length, 2);
            await roundTripHelpers(fd);
            await fd.discard();
            fd.close();
        });

        it("writes and reads across the page boundary", async () => {
            const fd = await fastFile.createOverride({ type: "bigMem" });
            const chunk = makeData(4096);
            const pos = BIGMEM_PAGE - 100; // straddles pages 0 and 1
            await fd.write(chunk, pos);
            const got = await fd.read(4096, pos);
            assert.deepStrictEqual([...got], [...chunk]);
            assert.strictEqual(fd.o.data.length, 2);
            fd.close();
        });

        it("read-only files reject out-of-bounds reads and writes", async () => {
            const fd = await fastFile.readExisting({ type: "bigMem", data: [makeData(16)] });
            await expect(fd.read(32, 0)).rejects.toThrow();
            await expect(fd.write(new Uint8Array(1), 0)).rejects.toThrow("read only");
        });

        it("readString handles long strings, page boundaries and a missing terminator", async () => {
            const enc = new TextEncoder();
            const fd = await fastFile.createOverride({ type: "bigMem" });

            // longer than the 2048-byte scan chunk
            const long = "a".repeat(5000);
            await fd.write(enc.encode(long), 0);
            await fd.write(new Uint8Array([0]), 5000);
            assert.strictEqual(await fd.readString(0), long);

            // string crossing the 4 MiB page boundary
            const cross = "b".repeat(200);
            await fd.write(enc.encode(cross), BIGMEM_PAGE - 100);
            await fd.write(new Uint8Array([0]), BIGMEM_PAGE + 100);
            assert.strictEqual(await fd.readString(BIGMEM_PAGE - 100), cross);

            // unterminated string: ends at EOF instead of spinning forever
            const fd2 = await fastFile.createOverride({ type: "bigMem" });
            await fd2.write(enc.encode("no-end"), 0);
            assert.strictEqual(await fd2.readString(0), "no-end");
            fd2.close();

            fd.close();
        });

        it("readString past the end of a writable file yields the empty string or ERROR at a page boundary", async () => {
            const fd = await fastFile.createOverride({ type: "bigMem" });
            await fd.write(new Uint8Array([1, 2, 3]), 0);
            assert.strictEqual(await fd.readString(100), "");
            // exactly at a page boundary the resized data has no next page
            await expect(fd.readString(BIGMEM_PAGE)).rejects.toThrow("ERROR");
            fd.close();
        });
    });

    describe("os backend extras", function () {
        const fileName = "test_os_extras.bin";

        afterEach(async () => {
            try { await fs.promises.unlink(fileName); } catch (e) { /* may not exist */ }
        });

        it("round-trips the numeric helpers", async () => {
            const fd = await fastFile.createOverride(fileName);
            await roundTripHelpers(fd);
            await fd.close();
        });

        it("grows a sub-blksize pageSize up to the filesystem block size", async () => {
            const fd = await fastFile.createOverride(fileName, 1 << 16, 256);
            assert.strictEqual(fd.pageSize % 256, 0);
            const stats = await fs.promises.stat(fileName);
            assert(fd.pageSize >= stats.blksize);
            await fd.close();
        });

        it("readString spans multiple pages", async () => {
            const enc = new TextEncoder();
            const fd = await fastFile.createOverride(fileName, 1 << 16, 1 << 12);
            const long = "s".repeat(10000); // > 2 pages of 4096
            await fd.write(enc.encode(long), 0);
            await fd.write(new Uint8Array([0]), 10000);
            assert.strictEqual(await fd.readString(0), long);
            await fd.close();
        });

        it("read(0) is a no-op and a direct-size read past EOF returns zero-filled bytes", async () => {
            const fd = await fastFile.createOverride(fileName, 1 << 22, 1 << 12);
            await fd.write(makeData(1 << 12), 0);
            const empty = await fd.read(0, 0);
            assert.strictEqual(empty.byteLength, 0);

            // >= directReadThreshold (1 MiB) with pos beyond EOF: clamps to
            // zero bytes read, destination stays zero-filled
            const past = await fd.read(1 << 20, 1 << 21);
            assert(past.every((b) => b === 0));
            await fd.close();
        });

        it("a large read overlapping dirty pages takes the cached path", async () => {
            const fd = await fastFile.createOverride(fileName, 1 << 23, 1 << 12);
            const small = makeData(4096);
            await fd.write(small, 0);       // small cached write: page 0 is dirty
            const got = await fd.read(1 << 20, 0); // direct-size read overlaps it
            assert.deepStrictEqual([...got.slice(0, 64)], [...small.slice(0, 64)]);
            await fd.close();
        });

        it("a direct-size write over previously cached pages stays coherent", async () => {
            const fd = await fastFile.createOverride(fileName, 1 << 22, 1 << 12);
            await fd.write(makeData(1 << 12), 0);
            await fd.read(16, 0); // populate the page cache
            const big = new Uint8Array(1 << 20).fill(0x5A);
            await fd.write(big, 0); // >= directWriteThreshold with cached overlap
            const got = await fd.read(32, 0);
            assert(got.every((b) => b === 0x5A));
            await fd.close();
        });

        it("discard closes and unlinks the file", async () => {
            const fd = await fastFile.createOverride(fileName);
            await fd.write(makeData(8), 0);
            await fd.discard();
            await expect(fs.promises.stat(fileName)).rejects.toThrow();
        });

        it("writing after close fails fast", async () => {
            const fd = await fastFile.createOverride(fileName);
            await fd.write(makeData(8), 0);
            await fd.close();
            await expect(fd.write(makeData(8), 0)).rejects.toThrow("Writing a closing file");
            await expect(fd.readString(0)).rejects.toThrow("Reading a closing file");
        });
    });

    describe("blob backend (RangeFile)", function () {
        function blobOf(data) {
            return new Blob([data]);
        }

        it("round-trips numeric helpers and strings, and evicts old pages", async () => {
            const enc = new TextEncoder();
            const data = new Uint8Array(1 << 16);
            data.set([4, 3, 2, 1], 0);            // ULE32 0x01020304
            data.set([0x0A, 0x0B, 0x0C, 0x0D], 4); // UBE32
            data.set([0xFF, 0xFF, 0xFF, 0xFF, 0x1F, 0, 0, 0], 8); // ULE64 0x1FFFFFFFFF
            data.set(enc.encode("blob-str"), 16);
            data[24] = 0;

            // pageSize 4 KiB, cacheSize == pageSize -> maxPagesLoaded 2:
            // touching many pages exercises cache eviction
            const fd = await fastFile.readExisting({ type: "blob", blob: blobOf(data), cacheSize: 1 << 12, pageSize: 1 << 12 });
            assert.strictEqual(await fd.readULE32(0), 0x01020304);
            assert.strictEqual(await fd.readUBE32(4), 0x0A0B0C0D);
            assert.strictEqual(await fd.readULE64(8), 0x1FFFFFFFFF);
            assert.strictEqual(await fd.readString(16), "blob-str");
            for (let p = 0; p < 8; p++) {
                await fd.read(4, p * (1 << 12));
            }
            assert(fd.pages.size <= fd.maxPagesLoaded);
            await fd.close();
        });

        it("readString without a terminator ends at EOF; sequential reads advance pos", async () => {
            const enc = new TextEncoder();
            const fd = await fastFile.readExisting({ type: "blob", blob: blobOf(enc.encode("abc\0defgh")) });
            assert.strictEqual(await fd.readString(), "abc");
            assert.strictEqual(await fd.readString(), "defgh"); // runs to EOF
            await fd.close();
        });

        it("rejects out-of-bounds reads and every write helper", async () => {
            const fd = await fastFile.readExisting({ type: "blob", blob: blobOf(makeData(16)) });
            await expect(fd.read(32, 0)).rejects.toThrow("Reading out of bounds");
            await expect(fd.write(new Uint8Array(1), 0)).rejects.toThrow("read only");
            await expect(fd.writeULE32(1, 0)).rejects.toThrow("read only");
            await expect(fd.writeUBE32(1, 0)).rejects.toThrow("read only");
            await expect(fd.writeULE64(1, 0)).rejects.toThrow("read only");
            await fd.discard(); // close()s; second close via discard is a no-op
            await expect(fd.readString(0)).rejects.toThrow("Reading a closing file");
        });

        it("surfaces short reads from a lying blob", async () => {
            const fake = {
                size: 100,
                slice: function () {
                    return { arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(1)); } };
                }
            };
            const fd = await fastFile.readExisting({ type: "blob", blob: fake });
            await expect(fd.read(50, 0)).rejects.toThrow("short blob read");
            // the failed page load was evicted, not cached
            assert.strictEqual(fd.pages.size, 0);
        });
    });

    describe("http backend probe fallbacks", function () {
        // Minimal configurable server: `mode` selects the probe behavior.
        function startServer(data, mode) {
            const server = http.createServer(function (req, res) {
                const range = req.headers.range;
                if (!range) { // plain GET (readFullyToMem)
                    res.writeHead(200, { "Content-Length": data.length });
                    res.end(Buffer.from(data));
                    return;
                }
                const m = /^bytes=(\d+)-(\d+)$/.exec(range);
                const start = parseInt(m[1]);
                const end = Math.min(parseInt(m[2]), data.length - 1);
                const isProbe = start === 0 && parseInt(m[1]) === 0 && parseInt(m[2]) === 0;

                if (mode === "probe-500") {
                    res.writeHead(500); res.end("boom"); return;
                }
                if (mode === "416-empty") {
                    res.writeHead(416, { "Content-Range": "bytes */0" }); res.end(); return;
                }
                if (mode === "416-other") {
                    res.writeHead(416, { "Content-Range": "bytes */" + data.length }); res.end(); return;
                }
                if (mode === "no-total") {
                    res.writeHead(206, { "Content-Range": "bytes 0-0/*", "Content-Length": 1 });
                    res.end(Buffer.from(data.slice(0, 1))); return;
                }
                if (mode === "fail-after-probe" && !isProbe) {
                    res.writeHead(500); res.end("boom"); return;
                }
                if (mode === "wrong-start" && !isProbe) {
                    const body = Buffer.from(data.slice(start + 1, end + 2));
                    res.writeHead(206, {
                        "Content-Range": "bytes " + (start + 1) + "-" + (end + 1) + "/" + data.length,
                        "Content-Length": body.length
                    });
                    res.end(body); return;
                }
                if (mode === "overlong" && !isProbe) {
                    const body = Buffer.concat([Buffer.from(data.slice(start, end + 1)), Buffer.alloc(10, 7)]);
                    res.writeHead(206, {
                        "Content-Range": "bytes " + start + "-" + end + "/" + data.length,
                        "Content-Length": body.length
                    });
                    res.end(body); return;
                }
                if (mode === "short" && !isProbe) {
                    const body = Buffer.from(data.slice(start, end)); // one byte short
                    res.writeHead(206, {
                        "Content-Range": "bytes " + start + "-" + end + "/" + data.length,
                        "Content-Length": body.length
                    });
                    res.end(body); return;
                }
                const body = Buffer.from(data.slice(start, end + 1));
                res.writeHead(206, {
                    "Content-Range": "bytes " + start + "-" + end + "/" + data.length,
                    "Content-Length": body.length,
                    "ETag": "\"v1\""
                });
                res.end(body);
            });
            return new Promise(function (resolve) {
                server.listen(0, "127.0.0.1", function () {
                    resolve({
                        url: "http://127.0.0.1:" + server.address().port + "/f.bin",
                        close: function () { return new Promise(function (r) { server.close(r); }); }
                    });
                });
            });
        }

        it("buffers fully when the total size is unknown (Content-Range */*)", async () => {
            const data = makeData(4096);
            const srv = await startServer(data, "no-total");
            try {
                const fd = await fastFile.readExisting(srv.url);
                assert.strictEqual(fd.totalSize, data.length);
                assert.deepStrictEqual([...(await fd.read(8, 100))], [...data.slice(100, 108)]);
                fd.close();
            } finally { await srv.close(); }
        });

        it("throws on a failing probe", async () => {
            const srv = await startServer(makeData(16), "probe-500");
            try {
                await expect(fastFile.readExisting(srv.url)).rejects.toThrow("HTTP 500");
            } finally { await srv.close(); }
        });

        it("treats 416 with a zero total as an empty file", async () => {
            const srv = await startServer(new Uint8Array(0), "416-empty");
            try {
                const fd = await fastFile.readExisting(srv.url);
                assert.strictEqual(fd.totalSize, 0);
                fd.close();
            } finally { await srv.close(); }
        });

        it("falls back to a full fetch on other 416 responses", async () => {
            const data = makeData(64);
            const srv = await startServer(data, "416-other");
            try {
                const fd = await fastFile.readExisting(srv.url);
                assert.strictEqual(fd.totalSize, data.length);
                fd.close();
            } finally { await srv.close(); }
        });

        it("rejects a range answered at the wrong offset", async () => {
            const srv = await startServer(makeData(1 << 17), "wrong-start");
            try {
                const fd = await fastFile.readExisting(srv.url);
                await expect(fd.read(1 << 16, 0)).rejects.toThrow("server returned range starting at");
                fd.close();
            } finally { await srv.close(); }
        });

        it("rejects a range response longer than requested", async () => {
            const srv = await startServer(makeData(1 << 17), "overlong");
            try {
                const fd = await fastFile.readExisting(srv.url);
                await expect(fd.read(1 << 16, 0)).rejects.toThrow("longer than requested");
                fd.close();
            } finally { await srv.close(); }
        });

        it("rejects a short range response", async () => {
            const srv = await startServer(makeData(1 << 17), "short");
            try {
                const fd = await fastFile.readExisting(srv.url);
                await expect(fd.read(1 << 16, 0)).rejects.toThrow("short range response");
                fd.close();
            } finally { await srv.close(); }
        });

        it("a failed page load is retried on the next read", async () => {
            const srv = await startServer(makeData(1 << 14), "fail-after-probe");
            try {
                const fd = await fastFile.readExisting(srv.url);
                await expect(fd.read(4, 0)).rejects.toThrow("HTTP 500");
                // the rejected page was evicted so a retry issues a new request
                await expect(fd.read(4, 0)).rejects.toThrow("HTTP 500");
                fd.close();
            } finally { await srv.close(); }
        });
    });
});
