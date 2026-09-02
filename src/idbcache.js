// IndexedDB-backed persistent block cache for positioned range readers.
//
// Wraps a `readRangeInto(dst, dstOffset, pos, len)` function (the http
// backend's reader) so that fetched bytes persist across page loads: a
// second proving session against the same URL serves its reads from
// IndexedDB instead of the network ("warm start"), while keeping every
// property of the streaming design -- the standard single-file format, and
// bounded memory (reads land directly in the caller's buffer; the cache
// only ever allocates up to two extra blocks for the request boundaries).
//
// Identity and consistency: entries are keyed by URL and stamped with the
// file's strong validator (ETag / Last-Modified) and total size. A changed
// validator or size drops the stale blocks at open. Without a strong
// validator the wrapper refuses to cache and returns the reader unchanged --
// a URL-only identity could silently serve bytes of a replaced file.
//
// Storage layout (one shared database):
//   files:  fileKey -> { validator, totalSize, blockSize, bytes, lastUsed }
//   blocks: [fileKey, blockIndex] -> Uint8Array (blockSize, tail may be short)
//
// Eviction is per-file LRU, applied at open: when the sum of cached bytes
// exceeds maxBytes, least-recently-opened files are dropped (never the one
// being opened). A zkey is useful as a whole or not at all, so file
// granularity beats block granularity here.
//
// Prototype limitations (documented, deliberate):
//   - concurrent readers of the same cold block both fetch it (last write
//     wins; bytes are identical by the validator guard);
//   - the 206-unknown-total and 416 fallbacks are not persisted; the
//     streaming path and the Range-less 200 path both populate the cache
//     (the latter via persistFullBody + conditional 304 probes);
//   - eviction only runs at open, not while a session writes new blocks.

const DEFAULT_BLOCK_SIZE = 1 << 21;   // 2 MiB: amortizes IDB per-op cost
const DEFAULT_MAX_BYTES = 1 << 29;    // 512 MiB across all cached files
const DEFAULT_DB_NAME = "fastfile-http-cache";

const dbConnections = new Map(); // dbName -> Promise<IDBDatabase>

function openDb(dbName) {
    if (dbConnections.has(dbName)) return dbConnections.get(dbName);
    const p = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore("files");
            db.createObjectStore("blocks");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
    dbConnections.set(dbName, p);
    p.catch(() => dbConnections.delete(dbName));
    return p;
}

// Small promise adapters over the IDB request API.
function idbReq(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
}

function blockRange(fileKey, from, to) {
    return IDBKeyRange.bound([fileKey, from], [fileKey, to]);
}

async function deleteFileEntries(db, fileKey) {
    const tx = db.transaction(["files", "blocks"], "readwrite");
    tx.objectStore("files").delete(fileKey);
    tx.objectStore("blocks").delete(blockRange(fileKey, 0, Infinity));
    await txDone(tx);
}

// Register the file, invalidate stale blocks, apply LRU eviction.
async function prepareFile(db, fileKey, validator, totalSize, blockSize, maxBytes) {
    const tx = db.transaction(["files", "blocks"], "readwrite");
    const files = tx.objectStore("files");
    const existing = await idbReq(files.get(fileKey));
    let bytes = 0;
    if (existing &&
        existing.validator === validator &&
        existing.totalSize === totalSize &&
        existing.blockSize === blockSize) {
        bytes = existing.bytes;
    } else if (existing) {
        // stale: same URL, different content or geometry
        tx.objectStore("blocks").delete(blockRange(fileKey, 0, Infinity));
    }
    files.put({ validator, totalSize, blockSize, bytes, lastUsed: Date.now() }, fileKey);
    await txDone(tx);

    // LRU eviction across files (never the one just opened).
    const rtx = db.transaction("files", "readonly");
    const store = rtx.objectStore("files");
    const [keys, metas] = await Promise.all([idbReq(store.getAllKeys()), idbReq(store.getAll())]);
    await txDone(rtx);
    let total = metas.reduce((s, mm) => s + mm.bytes, 0);
    if (total <= maxBytes) return;
    const victims = keys.map((k, i) => ({ key: k, meta: metas[i] }))
        .filter((f) => f.key !== fileKey)
        .sort((a, b) => a.meta.lastUsed - b.meta.lastUsed);
    for (const v of victims) {
        if (total <= maxBytes) break;
        await deleteFileEntries(db, v.key);
        total -= v.meta.bytes;
    }
}

// Wrap `readRangeInto` with the persistent cache. Returns the original
// reader unchanged when caching is impossible (no IndexedDB in this
// environment, storage blocked, or no strong validator to key on).
export async function wrapWithPersistentCache(readRangeInto, o) {
    const { fileKey, validator, totalSize } = o;
    const opts = (typeof o.options === "object" && o.options) || {};
    const blockSize = opts.blockSize || DEFAULT_BLOCK_SIZE;
    const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    const dbName = opts.dbName || DEFAULT_DB_NAME;

    if (typeof indexedDB === "undefined" || !validator) return readRangeInto;
    let db;
    try {
        db = await openDb(dbName);
        await prepareFile(db, fileKey, validator, totalSize, blockSize, maxBytes);
    } catch (e) {
        // Private windows, blocked site data, quota pressure at open: the
        // cache is a convenience, never a requirement.
        return readRangeInto;
    }

    let broken = false; // a failed write disables persistence, not reads

    async function loadCached(firstBlock, lastBlock) {
        const tx = db.transaction("blocks", "readonly");
        const store = tx.objectStore("blocks");
        const range = blockRange(fileKey, firstBlock, lastBlock);
        const [keys, values] = await Promise.all([idbReq(store.getAllKeys(range)), idbReq(store.getAll(range))]);
        await txDone(tx);
        const found = new Map();
        for (let i = 0; i < keys.length; i++) found.set(keys[i][1], values[i]);
        return found;
    }

    async function persistBlocks(entries) { // [{index, data}] with data copied already
        if (broken || entries.length === 0) return;
        try {
            const tx = db.transaction(["files", "blocks"], "readwrite");
            const blocks = tx.objectStore("blocks");
            const files = tx.objectStore("files");
            for (const e of entries) blocks.put(e.data, [fileKey, e.index]);
            const meta = await idbReq(files.get(fileKey));
            /* c8 ignore next -- meta vanishes only if another tab evicts mid-session */
            if (meta) {
                meta.bytes += entries.reduce((s, e) => s + e.data.byteLength, 0);
                meta.lastUsed = Date.now();
                files.put(meta, fileKey);
            }
            await txDone(tx);
        } catch (e) {
            broken = true; // quota exceeded etc.: keep reading, stop writing
        }
    }

    const blockLen = (index) =>
        Math.min(blockSize, totalSize - index * blockSize);

    // In-flight dedupe: provers issue concurrent, overlapping reads (MSM
    // read-ahead, coefficient streaming), and without this every concurrent
    // miss of the same block refetched it -- measured 3.3x the zkey size on
    // the wire for a cold authV3 proof. A missing block gets one fetch; every
    // other reader awaits its promise.
    const inFlight = new Map(); // blockIndex -> Promise<Uint8Array>
    function deferBlock(index) {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        promise.catch(() => {}); // waiters handle it; avoid unhandled-rejection noise
        inFlight.set(index, promise);
        return { resolve, reject, promise };
    }

    return async function cachedReadRangeInto(dst, dstOffset, pos, len) {
        if (len === 0) return;
        const firstBlock = Math.floor(pos / blockSize);
        const lastBlock = Math.floor((pos + len - 1) / blockSize);
        const found = await loadCached(firstBlock, lastBlock);

        const toPersist = [];
        const copyInto = (block, i) => {
            const bStart = i * blockSize;
            const from = Math.max(pos, bStart);
            const to = Math.min(pos + len, bStart + blockLen(i));
            dst.set(block.subarray(from - bStart, to - bStart), dstOffset + (from - pos));
        };
        // Walk the block range, serving hits (cached or in-flight) and
        // grouping misses into runs of blocks that lie fully inside the
        // request (fetched directly into dst, no extra copy) -- boundary
        // blocks that stick out past the request are fetched whole into a
        // one-block temp so the cache always stores complete blocks.
        let i = firstBlock;
        while (i <= lastBlock) {
            const bStart = i * blockSize;
            const bEnd = bStart + blockLen(i);
            const hit = found.get(i);
            if (hit) {
                copyInto(hit, i);
                i++;
                continue;
            }
            const pending = inFlight.get(i);
            if (pending) {
                copyInto(await pending, i);
                i++;
                continue;
            }
            if (bStart >= pos && bEnd <= pos + len) {
                // interior run: extend over consecutive interior misses
                let j = i;
                while (j + 1 <= lastBlock && !found.get(j + 1) && !inFlight.get(j + 1) &&
                       (j + 1) * blockSize + blockLen(j + 1) <= pos + len) j++;
                const runStart = bStart;
                const runEnd = j * blockSize + blockLen(j);
                const defers = [];
                for (let b = i; b <= j; b++) defers.push(deferBlock(b));
                try {
                    await readRangeInto(dst, dstOffset + (runStart - pos), runStart, runEnd - runStart);
                } catch (err) {
                    for (let b = i; b <= j; b++) { defers[b - i].reject(err); inFlight.delete(b); }
                    throw err;
                }
                for (let b = i; b <= j; b++) {
                    const s = b * blockSize;
                    const data = dst.slice(dstOffset + (s - pos), dstOffset + (s - pos) + blockLen(b));
                    defers[b - i].resolve(data);
                    toPersist.push({ index: b, data });
                }
                i = j + 1;
            } else {
                // boundary block partially outside the request: fetch it
                // whole so the stored block is complete
                const defer = deferBlock(i);
                const block = new Uint8Array(blockLen(i));
                try {
                    await readRangeInto(block, 0, bStart, block.length);
                } catch (err) {
                    defer.reject(err);
                    inFlight.delete(i);
                    throw err;
                }
                defer.resolve(block);
                copyInto(block, i);
                toPersist.push({ index: i, data: block });
                i++;
            }
        }
        await persistBlocks(toPersist);
        // keep resolved blocks discoverable until they are persisted, then
        // let waiters fall through to IndexedDB
        for (const e of toPersist) inFlight.delete(e.index);
    };
}

// Peek at what the cache knows about a URL before any network request.
// Returns { validator, totalSize, blockSize, bytes } or null. Used to send a
// conditional probe (If-None-Match / If-Modified-Since): an unchanged file
// answers 304 with no body, which is what makes warm starts work even
// against servers that ignore Range and would otherwise ship the whole file
// in the probe response.
export async function peekPersistentMeta(o) {
    const opts = (typeof o.options === "object" && o.options) || {};
    const dbName = opts.dbName || DEFAULT_DB_NAME;
    if (typeof indexedDB === "undefined") return null;
    try {
        const db = await openDb(dbName);
        const tx = db.transaction("files", "readonly");
        const meta = await idbReq(tx.objectStore("files").get(o.fileKey));
        await txDone(tx);
        return meta ? { validator: meta.validator, totalSize: meta.totalSize, blockSize: meta.blockSize, bytes: meta.bytes } : null;
    } catch (e) {
        return null;
    }
}

// Persist a fully-downloaded body (the Range-less server path) so the next
// session can warm-start from it. Blocks are written in bounded batches;
// meta.bytes is set to the exact total afterwards (overwrites make
// incremental accounting drift). Best-effort: returns false when the
// environment has no usable IndexedDB or a write fails.
export async function persistFullBody(o) {
    const { fileKey, validator, totalSize, data } = o;
    const opts = (typeof o.options === "object" && o.options) || {};
    const blockSize = opts.blockSize || DEFAULT_BLOCK_SIZE;
    const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    const dbName = opts.dbName || DEFAULT_DB_NAME;
    if (typeof indexedDB === "undefined" || !validator) return false;
    try {
        const db = await openDb(dbName);
        await prepareFile(db, fileKey, validator, totalSize, blockSize, maxBytes);
        const nBlocks = Math.ceil(totalSize / blockSize);
        const BATCH = 64;
        for (let b0 = 0; b0 < nBlocks; b0 += BATCH) {
            const tx = db.transaction("blocks", "readwrite");
            const blocks = tx.objectStore("blocks");
            for (let b = b0; b < Math.min(b0 + BATCH, nBlocks); b++) {
                const s = b * blockSize;
                blocks.put(data.slice(s, Math.min(s + blockSize, totalSize)), [fileKey, b]);
            }
            await txDone(tx);
        }
        const tx = db.transaction("files", "readwrite");
        const files = tx.objectStore("files");
        const meta = await idbReq(files.get(fileKey));
        /* c8 ignore else -- meta vanishes only if another tab evicts mid-write */
        if (meta) {
            meta.bytes = totalSize;
            meta.lastUsed = Date.now();
            files.put(meta, fileKey);
        }
        await txDone(tx);
        return true;
    } catch (e) {
        return false;
    }
}
