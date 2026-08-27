import * as fastFile from "../src/fastfile.browser.js";
import { expect, vi } from "vitest";

// In-Chromium tests for the IndexedDB-backed persistent block cache
// (persistentCache option of the http backend). fetch is stubbed with a
// deterministic Range-honoring server that counts requests, so warm starts
// are provable as "zero network requests".

const FILE_SIZE = 5 * 1024 * 1024 + 123; // deliberately not block-aligned
const BLOCK = 1 << 20;                   // 1 MiB test blocks

function makeContent(seed) {
    const data = new Uint8Array(FILE_SIZE);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + seed) & 0xff;
    return data;
}

// A minimal Range-capable origin: 206 with Content-Range, strong ETag.
function serveRanges(content, etag, counter) {
    return (url, opts) => {
        counter.count++;
        const range = opts && opts.headers && opts.headers["Range"];
        const m = /bytes=(\d+)-(\d+)/.exec(range || "");
        const from = m ? parseInt(m[1]) : 0;
        const to = m ? Math.min(parseInt(m[2]), content.length - 1) : content.length - 1;
        counter.bytes += to - from + 1;
        const body = content.slice(from, to + 1);
        return Promise.resolve({
            ok: true,
            status: 206,
            headers: new Headers({
                "content-range": `bytes ${from}-${to}/${content.length}`,
                "etag": etag,
            }),
            arrayBuffer: () => Promise.resolve(body.buffer.slice(0)),
            body: null, // exercise the non-streaming fallback (jsdom-style)
        });
    };
}

async function openCached(url, cacheOpts) {
    return fastFile.readExisting({
        type: "http",
        url,
        persistentCache: cacheOpts || { blockSize: BLOCK, dbName: "fastfile-test-cache" },
    });
}

function clearDb(name) {
    return new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
}

describe("IndexedDB persistent block cache", function () {
    const URL1 = "https://cache.example/circuit.zkey";

    beforeEach(async () => {
        // fresh DB per test -- but note the module keeps its connection
        // per dbName, so tests use distinct dbNames where isolation matters
        await clearDb("fastfile-test-cache");
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("cold reads are correct across block boundaries and warm reads hit no network", async () => {
        const content = makeContent(7);
        const counter = { count: 0, bytes: 0 };
        vi.stubGlobal("fetch", serveRanges(content, "\"v1\"", counter));

        const dbName = "fastfile-test-warm";
        await clearDb(dbName);
        const fd = await openCached(URL1, { blockSize: BLOCK, dbName });

        // unaligned read spanning interior + boundary blocks
        const big = await fd.read(3 * BLOCK, BLOCK + 17);
        expect([...big.slice(0, 8)]).toEqual([...content.subarray(BLOCK + 17, BLOCK + 25)]);
        expect([...big.slice(-8)]).toEqual([...content.subarray(4 * BLOCK + 9, 4 * BLOCK + 17)]);
        // small header-style read
        const head = await fd.read(16, 4);
        expect([...head]).toEqual([...content.subarray(4, 20)]);
        // tail read hitting the short last block
        const tail = await fd.read(100, FILE_SIZE - 100);
        expect([...tail]).toEqual([...content.subarray(FILE_SIZE - 100)]);
        await fd.close();
        const coldFetches = counter.count;
        expect(coldFetches).toBeGreaterThan(0);

        // warm start: new handle, same URL -- all reads served from IDB
        const fd2 = await openCached(URL1, { blockSize: BLOCK, dbName });
        const probeFetches = counter.count - coldFetches; // open() probe only
        const big2 = await fd2.read(3 * BLOCK, BLOCK + 17);
        expect([...big2.slice(0, 32)]).toEqual([...big.slice(0, 32)]);
        const tail2 = await fd2.read(100, FILE_SIZE - 100);
        expect([...tail2]).toEqual([...tail]);
        await fd2.close();
        expect(counter.count - coldFetches - probeFetches).toBe(0);
        expect(probeFetches).toBe(1);
    });

    it("a changed validator invalidates the cached blocks", async () => {
        const dbName = "fastfile-test-inval";
        await clearDb(dbName);

        const v1 = makeContent(1);
        const c1 = { count: 0, bytes: 0 };
        vi.stubGlobal("fetch", serveRanges(v1, "\"v1\"", c1));
        const fd1 = await openCached(URL1, { blockSize: BLOCK, dbName });
        await fd1.read(64, 0);
        await fd1.close();

        // same URL, new content + new ETag
        const v2 = makeContent(2);
        const c2 = { count: 0, bytes: 0 };
        vi.stubGlobal("fetch", serveRanges(v2, "\"v2\"", c2));
        const fd2 = await openCached(URL1, { blockSize: BLOCK, dbName });
        const got = await fd2.read(64, 0);
        await fd2.close();
        expect([...got]).toEqual([...v2.subarray(0, 64)]);
        expect(c2.count).toBeGreaterThan(1); // probe + at least one real refetch
    });

    it("LRU eviction drops the least recently opened file, never the current one", async () => {
        const dbName = "fastfile-test-evict";
        await clearDb(dbName);
        const opts = { blockSize: BLOCK, dbName, maxBytes: 4 * BLOCK };

        const contentA = makeContent(10);
        const cA = { count: 0, bytes: 0 };
        vi.stubGlobal("fetch", serveRanges(contentA, "\"a1\"", cA));
        const fa = await fastFile.readExisting({ type: "http", url: "https://cache.example/a.zkey", persistentCache: opts });
        await fa.read(3 * BLOCK, 0); // caches 3 MiB for A
        await fa.close();

        const contentB = makeContent(20);
        const cB = { count: 0, bytes: 0 };
        vi.stubGlobal("fetch", serveRanges(contentB, "\"b1\"", cB));
        const fb = await fastFile.readExisting({ type: "http", url: "https://cache.example/b.zkey", persistentCache: opts });
        await fb.read(3 * BLOCK, 0); // A(3) + B(3) > maxBytes at next open
        await fb.close();

        // reopening B evicts A (older lastUsed) and keeps B warm
        const cB2 = { count: 0, bytes: 0 };
        vi.stubGlobal("fetch", serveRanges(contentB, "\"b1\"", cB2));
        const fb2 = await fastFile.readExisting({ type: "http", url: "https://cache.example/b.zkey", persistentCache: opts });
        await fb2.read(3 * BLOCK, 0);
        await fb2.close();
        expect(cB2.count).toBe(1); // probe only: B stayed cached

        // A must refetch its data
        const cA2 = { count: 0, bytes: 0 };
        vi.stubGlobal("fetch", serveRanges(contentA, "\"a1\"", cA2));
        const fa2 = await fastFile.readExisting({ type: "http", url: "https://cache.example/a.zkey", persistentCache: opts });
        const back = await fa2.read(64, 0);
        await fa2.close();
        expect([...back]).toEqual([...contentA.subarray(0, 64)]);
        expect(cA2.count).toBeGreaterThan(1);
    });

    it("concurrent cold reads of one block fetch it once (in-flight dedupe)", async () => {
        const dbName = "fastfile-test-dedupe";
        await clearDb(dbName);
        const content = makeContent(9);
        const counter = { count: 0, bytes: 0 };
        vi.stubGlobal("fetch", serveRanges(content, "\"d1\"", counter));

        const fd = await openCached("https://cache.example/dedupe.zkey", { blockSize: BLOCK, dbName });
        const afterOpen = counter.count; // the probe
        // 8 concurrent direct reads inside block 0 (each is a boundary-case
        // miss); without dedupe each fetched the whole block independently
        const reads = [];
        for (let k = 0; k < 8; k++) reads.push(fd.read(128 * 1024, k * 64 * 1024));
        const got = await Promise.all(reads);
        for (let k = 0; k < 8; k++) {
            expect([...got[k].slice(0, 8)]).toEqual([...content.subarray(k * 64 * 1024, k * 64 * 1024 + 8)]);
        }
        await fd.close();
        // block 0 once, plus at most one more block touched by the last read
        expect(counter.count - afterOpen).toBeLessThanOrEqual(2);
    });

    it("without a strong validator the reader works but nothing persists", async () => {
        const dbName = "fastfile-test-noval";
        await clearDb(dbName);
        const content = makeContent(3);
        const counter = { count: 0, bytes: 0 };
        const server = serveRanges(content, "", counter);
        vi.stubGlobal("fetch", (url, opts) => server(url, opts).then((r) => {
            r.headers = new Headers({ "content-range": r.headers.get("content-range") });
            return r;
        }));

        const fd = await openCached("https://cache.example/nova.zkey", { blockSize: BLOCK, dbName });
        const got = await fd.read(64, 0);
        expect([...got]).toEqual([...content.subarray(0, 64)]);
        await fd.close();
        const cold = counter.count;

        const fd2 = await openCached("https://cache.example/nova.zkey", { blockSize: BLOCK, dbName });
        await fd2.read(64, 0);
        await fd2.close();
        expect(counter.count).toBeGreaterThan(cold + 1); // re-fetched: no cache without validator
    });
});
