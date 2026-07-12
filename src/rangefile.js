// Shared read-only file over an abstract positioned range reader.
//
// Backends (httpfile, blobfile) supply a single primitive:
//     readRangeInto(dstBuff, dstOffset, pos, len) -> Promise<void>
// and this class layers the FastFile read interface on top:
//   - reads >= pageSize bypass the cache and go straight to the backend
//     (the file is read-only, so a direct read is always coherent);
//   - smaller reads (header scans: magics, section tables, ULE32/64) are
//     served from page-aligned cached ranges so that e.g. a binfile section
//     scan does not issue one backend request per 4-byte field.
//
// Write operations throw: remote ranges are strictly a read transport.

const DEFAULT_CACHE_SIZE = 1 << 20;
const DEFAULT_PAGE_SIZE = 1 << 13;

export class RangeFile {

    constructor(readRangeInto, totalSize, cacheSize, pageSize) {
        this.readRangeInto = readRangeInto;
        this.totalSize = totalSize;
        this.pos = 0;
        this.pageSize = pageSize || DEFAULT_PAGE_SIZE;
        this.maxPagesLoaded = Math.floor((cacheSize || DEFAULT_CACHE_SIZE) / this.pageSize) + 1;
        this.pages = new Map();      // page index -> { buff: Uint8Array|null, promise: Promise }
        this.readOnly = true;
    }

    _pageLen(p) {
        const start = p * this.pageSize;
        const end = Math.min(start + this.pageSize, this.totalSize);
        return end - start;
    }

    // Load (or join the in-flight load of) page p; resolves to its buffer.
    // A failed load removes the entry so a later retry re-requests it.
    _loadPage(p) {
        const self = this;
        let page = self.pages.get(p);
        if (page) {
            // LRU touch: re-insert so Map iteration order tracks recency.
            self.pages.delete(p);
            self.pages.set(p, page);
            return page.promise;
        }
        const buff = new Uint8Array(self._pageLen(p));
        page = { buff: null, promise: null };
        page.promise = self.readRangeInto(buff, 0, p * self.pageSize, buff.byteLength).then(function () {
            page.buff = buff;
            return buff;
        }, function (err) {
            self.pages.delete(p);
            throw err;
        });
        self.pages.set(p, page);
        self._trimCache();
        return page.promise;
    }

    _trimCache() {
        const self = this;
        if (self.pages.size <= self.maxPagesLoaded) return;
        // Evict oldest settled pages first; in-flight loads are kept.
        for (const entry of self.pages) {
            if (self.pages.size <= self.maxPagesLoaded) return;
            if (entry[1].buff) self.pages.delete(entry[0]);
        }
    }

    async readToBuffer(buffDst, offset, len, pos) {
        const self = this;
        if (len === 0) return;
        if (self.pendingClose) throw new Error("Reading a closing file");
        if (typeof pos === "undefined") pos = self.pos;
        if (pos + len > self.totalSize) throw new Error("Reading out of bounds");
        self.pos = pos + len;

        // Direct path: one backend request straight into the destination
        // (works for both typed arrays and BigBuffer via .set()).
        if (len >= self.pageSize) {
            await self.readRangeInto(buffDst, offset, pos, len);
            return;
        }

        const firstPage = Math.floor(pos / self.pageSize);
        const lastPage = Math.floor((pos + len - 1) / self.pageSize);
        let o = pos % self.pageSize;
        let done = 0;
        for (let p = firstPage; p <= lastPage; p++) {
            const buff = await self._loadPage(p);
            const l = Math.min(len - done, self.pageSize - o);
            buffDst.set(buff.subarray(o, o + l), offset + done);
            done += l;
            o = 0;
        }
    }

    async read(len, pos) {
        const buff = new Uint8Array(len);
        await this.readToBuffer(buff, 0, len, pos);
        return buff;
    }

    async readULE32(pos) {
        const b = await this.read(4, pos);
        const view = new Uint32Array(b.buffer);
        return view[0];
    }

    async readUBE32(pos) {
        const b = await this.read(4, pos);
        const view = new DataView(b.buffer);
        return view.getUint32(0, false);
    }

    async readULE64(pos) {
        const b = await this.read(8, pos);
        const view = new Uint32Array(b.buffer);
        return view[1] * 0x100000000 + view[0];
    }

    async readString(pos) {
        const self = this;
        if (self.pendingClose) throw new Error("Reading a closing file");
        let p = typeof pos === "undefined" ? self.pos : pos;
        const chunks = [];
        while (p < self.totalSize) {
            const l = Math.min(self.pageSize, self.totalSize - p);
            const chunk = await self.read(l, p);
            const z = chunk.indexOf(0);
            if (z >= 0) {
                chunks.push(chunk.subarray(0, z));
                self.pos = p + z + 1;
                return decodeChunks(chunks);
            }
            chunks.push(chunk);
            p += l;
        }
        // No terminator before EOF: the string ends at EOF.
        self.pos = p;
        return decodeChunks(chunks);
    }

    async write() {
        throw new Error("Writing a read only file");
    }

    async writeULE32() {
        throw new Error("Writing a read only file");
    }

    async writeUBE32() {
        throw new Error("Writing a read only file");
    }

    async writeULE64() {
        throw new Error("Writing a read only file");
    }

    async close() {
        if (this.pendingClose) throw new Error("Closing the file twice");
        this.pendingClose = true;
        this.pages.clear();
    }

    async discard() {
        await this.close();
    }
}

function decodeChunks(chunks) {
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
    const all = new Uint8Array(total);
    let o = 0;
    for (let i = 0; i < chunks.length; i++) {
        all.set(chunks[i], o);
        o += chunks[i].byteLength;
    }
    return new TextDecoder().decode(all);
}
