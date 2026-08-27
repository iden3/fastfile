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
//   - the degraded full-body path and the no-Range fallback are not
//     persisted; only the streaming path populates the cache;
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

    return async function cachedReadRangeInto(dst, dstOffset, pos, len) {
        if (len === 0) return;
        const firstBlock = Math.floor(pos / blockSize);
        const lastBlock = Math.floor((pos + len - 1) / blockSize);
        const found = await loadCached(firstBlock, lastBlock);

        const toPersist = [];
        // Walk the block range, serving hits and grouping misses into runs
        // of blocks that lie fully inside the request (fetched directly
        // into dst, no extra copy) -- boundary blocks that stick out past
        // the request are fetched whole into a one-block temp so the cache
        // always stores complete blocks.
        let i = firstBlock;
        while (i <= lastBlock) {
            const bStart = i * blockSize;
            const bEnd = bStart + blockLen(i);
            const hit = found.get(i);
            if (hit) {
                const from = Math.max(pos, bStart);
                const to = Math.min(pos + len, bEnd);
                dst.set(hit.subarray(from - bStart, to - bStart), dstOffset + (from - pos));
                i++;
                continue;
            }
            if (bStart >= pos && bEnd <= pos + len) {
                // interior run: extend over consecutive interior misses
                let j = i;
                while (j + 1 <= lastBlock && !found.get(j + 1) &&
                       (j + 1) * blockSize + blockLen(j + 1) <= pos + len) j++;
                const runStart = bStart;
                const runEnd = j * blockSize + blockLen(j);
                await readRangeInto(dst, dstOffset + (runStart - pos), runStart, runEnd - runStart);
                for (let b = i; b <= j; b++) {
                    const s = b * blockSize;
                    toPersist.push({ index: b, data: dst.slice(dstOffset + (s - pos), dstOffset + (s - pos) + blockLen(b)) });
                }
                i = j + 1;
            } else {
                // boundary block partially outside the request: fetch it
                // whole so the stored block is complete
                const block = new Uint8Array(blockLen(i));
                await readRangeInto(block, 0, bStart, block.length);
                const from = Math.max(pos, bStart);
                const to = Math.min(pos + len, bEnd);
                dst.set(block.subarray(from - bStart, to - bStart), dstOffset + (from - pos));
                toPersist.push({ index: i, data: block });
                i++;
            }
        }
        await persistBlocks(toPersist);
    };
}
