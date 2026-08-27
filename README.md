# fastfile

fastfile is a package to read/write binary files through one small async API
backed by a transparent page cache. The same `FastFile` interface works over
several backends, so code written against it (for example the snarkjs
zkey/ptau readers) runs unchanged whether the data lives on disk, in memory,
behind an HTTP URL, or inside a browser `Blob`.

## Capabilities

- **Page-cached reads and writes** — small reads (headers, section tables,
  `readULE32`-style scans) are served from cached pages; writes are cached and
  flushed asynchronously, so sequential access to big files stays fast.
- **Multiple backends behind one API**:

  | Backend | Type tag | Where | What it is for |
  |---|---|---|---|
  | OS file | `file` | Node | Regular files, with direct-I/O fast paths for large aligned reads/writes |
  | Memory | `mem` | Node + browser | A `Uint8Array` you already have, or a scratch file that never touches disk |
  | Big memory | `bigMem` | Node + browser | Like `mem`, but paged so it can hold buffers past the V8 single-allocation limits |
  | HTTP(S) | `http` | Node + browser | Read-only streaming over `Range` requests; falls back to buffering the whole body when the server does not support ranges |
  | Blob | `blob` | Browser (and Node ≥ 18) | Read-only zero-copy reads from a `Blob`/`File` (e.g. `<input type="file">`), so multi-GB files stream chunk-by-chunk |

- **Bounded memory on huge remote files** — with the `http` and `blob`
  backends, large reads stream straight into the caller's buffer and only the
  small-read page cache is retained; the whole file is never resident.
- **Node/browser split at package level** — the `exports` map gives Node the
  filesystem implementation and gives bundlers a browser build with the
  file backend removed (`mem`, `bigMem`, `http` and `blob` remain).

## Install

```
npm install fastfile
```

## API

All entry points return a promise of a `FastFile` handle:

- `createOverride(o, cacheSize?, pageSize?)` — create a file, truncating any
  existing one.
- `createNoOverride(o, cacheSize?, pageSize?)` — create a file, failing if it
  already exists (Node only distinction; alias of `createOverride` in the
  browser).
- `readExisting(o, cacheSize?, pageSize?)` — open read-only. Accepts the most
  input shapes (see the examples).
- `readWriteExisting(o, cacheSize?, pageSize?)` — open an existing file
  read/write.
- `readWriteExistingOrCreate(o, cacheSize?, pageSize?)` — like the above but
  creates the file when missing.

`o` is a file name/URL string, a `Uint8Array`, a `Blob`, or an options object
with a `type` tag from the table above. `cacheSize` (default 64 KiB) and
`pageSize` (default 8 KiB) tune the page cache.

The returned handle offers, among others:

```
read(len, pos)                readToBuffer(buff, offset, len, pos)
write(buff, pos)              readString(pos)
readULE32/readULE64/readUBE32(pos)
writeULE32/writeULE64/writeUBE32(v, pos)
totalSize                     close()      discard()
```

Reads return `Uint8Array`s. `close()` flushes pending writes and is
idempotent (repeat calls return the same promise instead of throwing).

## Examples

### OS files (Node)

```javascript
import * as fastFile from "fastfile";

const f = await fastFile.createOverride("pattern.bin");
const buff = Buffer.from("0001020304050607", "hex");
for (let i = 0; i < 1000; i++) {
    await f.write(buff, i * 8);
}
await f.close();

const r = await fastFile.readExisting("pattern.bin");
const bytes = await r.read(16, 8);   // 16 bytes from offset 8
await r.close();
```

From CommonJS use `const fastFile = require("fastfile");` — the `require`
condition resolves to the CJS build.

### Memory

```javascript
// Wrap bytes you already have (zero-copy):
const f1 = await fastFile.readExisting(new Uint8Array([1, 2, 3, 4]));

// Scratch file that never touches disk:
const f2 = await fastFile.createOverride({ type: "mem" });
await f2.writeULE32(42, 0);

// Beyond the single-allocation limit (paged):
const f3 = await fastFile.createOverride({ type: "bigMem" });
```

### HTTP(S) with Range streaming

```javascript
// Works in Node and in the browser. Probes the server with
// `Range: bytes=0-0`: when ranges are supported, every read becomes a range
// request and large reads stream directly into your buffer -- the file is
// never fully resident. When the server ignores Range, the body is buffered
// once (the historical behavior).
const f = await fastFile.readExisting("https://example.com/circuit_final.zkey");
console.log(f.totalSize);
const header = await f.read(32, 0);
await f.close();

// Explicit form with cache tuning:
const g = await fastFile.readExisting({
    type: "http",
    url: "https://example.com/powersOfTau28_hez_final_10.ptau",
    cacheSize: 1 << 20,
    pageSize: 1 << 16,
});
```

### Blob / File (browser)

```javascript
// e.g. a multi-GB zkey selected by the user; blob.slice() is zero-copy, so
// bytes reach memory only as they are read.
document.querySelector("input[type=file]").addEventListener("change", async (e) => {
    const f = await fastFile.readExisting(e.target.files[0]);
    const magic = await f.read(4, 0);
    await f.close();
});
```

### In the browser

Bundlers pick the browser build automatically via the package `exports`.
String inputs to `readExisting` are treated as URLs (there is no filesystem);
writable files must be `mem`/`bigMem`. The file backend throws
`"File I/O is not supported in the browser"`.

## License

fastfile is part of the iden3 project copyright 2018-2026 0KIMS association
and published with GPL-3 license. Please check the COPYING file for more
details.
