'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var fs = require('fs');
var constants = require('constants');

function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

var fs__default = /*#__PURE__*/_interopDefaultLegacy(fs);

async function open(fileName, openFlags, cacheSize, pageSize) {
    cacheSize = cacheSize || 4096*64;
    if (typeof openFlags !== "number" && ["w+", "wx+", "r", "ax+", "a+"].indexOf(openFlags) <0)
        throw new Error("Invalid open option");
    const fd =await fs__default["default"].promises.open(fileName, openFlags);

    const stats = await fd.stat();

    return  new FastFile(fd, stats, cacheSize, pageSize, fileName);
}


class FastFile {

    constructor(fd, stats, cacheSize, pageSize, fileName) {
        this.fileName = fileName;
        this.fd = fd;
        this.pos = 0;
        this.pageSize = pageSize || (1 << 8);
        while (this.pageSize < stats.blksize) {
            this.pageSize *= 2;
        }
        this.totalSize = stats.size;
        this.totalPages = Math.floor((stats.size -1) / this.pageSize)+1;
        this.maxPagesLoaded = Math.floor( cacheSize / this.pageSize)+1;
        // Reads/writes at least this large bypass the page cache and move bytes
        // straight between disk and the caller's buffer (see readToBuffer /
        // write), avoiding the extra buffer<->page copy that dominates large
        // sequential transfers (e.g. zkey/ptau sections).
        this.directReadThreshold = 1 << 20;
        this.directWriteThreshold = 1 << 20;
        this.pages = {};
        this.pendingLoads = [];
        this.writing = false;
        this.reading = false;
        this.avBuffs = [];
        this.history = {};
    }

    _loadPage(p) {
        const self = this;
        const P = new Promise((resolve, reject)=> {
            self.pendingLoads.push({
                page: p,
                resolve: resolve,
                reject: reject
            });
        });
        self.__statusPage("After Load request: ", p);
        return P;
    }

    __statusPage(s, p) {
        const logEntry = [];
        const self=this;
        if (!self.logHistory) return;
        logEntry.push("==" + s+ " " +p);
        let S = "";
        for (let i=0; i<self.pendingLoads.length; i++) {
            if (self.pendingLoads[i].page == p) S = S + " " + i;
        }
        if (S) logEntry.push("Pending loads:"+S);
        if (typeof self.pages[p] != "undefined") {
            const page = self.pages[p];
            logEntry.push("Loaded");
            logEntry.push("pendingOps: "+page.pendingOps);
            if (page.loading) logEntry.push("loading: "+page.loading);
            if (page.writing) logEntry.push("writing");
            if (page.dirty) logEntry.push("dirty");
        }
        logEntry.push("==");

        if (!self.history[p]) self.history[p] = [];
        self.history[p].push(logEntry);
    }

    __printHistory(p) {
        const self = this;
        if (!self.history[p]) console.log("Empty History ", p);
        console.log("History "+p);
        for (let i=0; i<self.history[p].length; i++) {
            for (let j=0; j<self.history[p][i].length; j++) {
                console.log("-> " + self.history[p][i][j]);
            }
        }
    }



    _triggerLoad() {
        const self = this;

        if (self.reading) return;
        if (self.pendingLoads.length==0) return;

        const pageIdxs = Object.keys(self.pages);

        const deletablePages = [];
        for (let i=0; i<pageIdxs.length; i++) {
            const page = self.pages[parseInt(pageIdxs[i])];
            if ((page.dirty == false)&&(page.pendingOps==0)&&(!page.writing)&&(!page.loading)) deletablePages.push(parseInt(pageIdxs[i]));
        }

        let freePages = self.maxPagesLoaded - pageIdxs.length;

        const ops = [];

        // while pending loads and
        //     the page is loaded or I can recover one.
        while (
            (self.pendingLoads.length>0) &&
            (   (typeof self.pages[self.pendingLoads[0].page] != "undefined" )
              ||(  (freePages>0)
                 ||(deletablePages.length>0)))) {
            const load = self.pendingLoads.shift();
            if (typeof self.pages[load.page] != "undefined") {
                self.pages[load.page].pendingOps ++;
                const idx = deletablePages.indexOf(load.page);
                if (idx>=0) deletablePages.splice(idx, 1);
                if (self.pages[load.page].loading) {
                    self.pages[load.page].loading.push(load);
                } else {
                    load.resolve();
                }
                self.__statusPage("After Load (cached): ", load.page);

            } else {
                if (freePages) {
                    freePages--;
                } else {
                    const fp = deletablePages.shift();
                    self.__statusPage("Before Unload: ", fp);
                    self.avBuffs.unshift(self.pages[fp]);
                    delete self.pages[fp];
                    self.__statusPage("After Unload: ", fp);
                }

                if (load.page>=self.totalPages) {
                    self.pages[load.page] = getNewPage();
                    load.resolve();
                    self.__statusPage("After Load (new): ", load.page);
                } else {
                    self.reading = true;
                    self.pages[load.page] = getNewPage();
                    self.pages[load.page].loading = [load];
                    ops.push(self.fd.read(self.pages[load.page].buff, 0, self.pageSize, load.page*self.pageSize).then((res)=> {
                        self.pages[load.page].size = res.bytesRead;
                        const loading = self.pages[load.page].loading;
                        delete self.pages[load.page].loading;
                        for (let i=0; i<loading.length; i++) {
                            loading[i].resolve();
                        }
                        self.__statusPage("After Load (loaded): ", load.page);
                        return res;
                    }, (err) => {
                        // Reject EVERY waiter, not just the first: co-readers of the
                        // same page were appended to page.loading (not to `load`) and
                        // would otherwise await forever. Drop the page entirely so a
                        // later retry re-reads it instead of queueing onto a dead
                        // loading list.
                        const page = self.pages[load.page];
                        const loading = (page && page.loading) ? page.loading : [load];
                        delete self.pages[load.page];
                        for (let i=0; i<loading.length; i++) {
                            loading[i].reject(err);
                        }
                    }));
                    self.__statusPage("After Load (loading): ", load.page);
                }
            }
        }
        // if (ops.length>1) console.log(ops.length);

        Promise.all(ops).then( () => {
            self.reading = false;
            if (self.pendingLoads.length>0) setImmediate(self._triggerLoad.bind(self));
            self._tryClose();
        });

        function getNewPage() {
            if (self.avBuffs.length>0) {
                const p = self.avBuffs.shift();
                p.dirty = false;
                p.pendingOps = 1;
                p.size =0;
                return p;
            } else {
                return {
                    dirty: false,
                    buff: new Uint8Array(self.pageSize),
                    pendingOps: 1,
                    size: 0
                };
            }
        }

    }


    _triggerWrite() {
        const self = this;
        if (self.writing) return;

        const pageIdxs = Object.keys(self.pages);

        const ops = [];

        for (let i=0; i<pageIdxs.length; i++) {
            const page = self.pages[parseInt(pageIdxs[i])];
            if (page.dirty) {
                page.dirty = false;
                page.writing = true;
                self.writing = true;
                ops.push( self.fd.write(page.buff, 0, page.size, parseInt(pageIdxs[i])*self.pageSize).then(() => {
                    page.writing = false;
                    return;
                }, (err) => {
                    console.log("ERROR Writing: "+err);
                    // Clear `writing` (a stuck flag pins the page forever and
                    // blocks _tryClose) and record the error. write()/read()
                    // surface it on their next call (fail fast) and close()
                    // rejects with it -- previously it was only visible at
                    // close(), so a prover that skipped close on error paths
                    // silently produced a truncated/corrupt file.
                    page.writing = false;
                    self.error = err;
                    self._tryClose();
                }));
            }
        }

        if (self.writing) {
            Promise.all(ops).then( () => {
                self.writing = false;
                setImmediate(self._triggerWrite.bind(self));
                self._tryClose();
                if (self.pendingLoads.length>0) setImmediate(self._triggerLoad.bind(self));
            });
        }
    }

    _getDirtyPage() {
        for (let p in this.pages) {
            if (this.pages[p].dirty) return p;
        }
        return -1;
    }

    // Iterate the actually-cached pages (usually few) rather than every page
    // index in [firstPage, lastPage], so the check stays O(cached pages) even
    // for very large ranges / small page sizes.
    _rangeHasCachedPages(pos, len) {
        const firstPage = Math.floor(pos / this.pageSize);
        const lastPage = Math.floor((pos + len - 1) / this.pageSize);
        for (const k of Object.keys(this.pages)) {
            const p = +k;
            if (p >= firstPage && p <= lastPage) return true;
        }
        return false;
    }

    async write(buff, pos) {
        if (buff.byteLength == 0) return;
        const self = this;
        if (self.error) throw self.error;
        if (typeof pos == "undefined") pos = self.pos;
        self.pos = pos+buff.byteLength;
        if (self.totalSize < pos + buff.byteLength) self.totalSize = pos + buff.byteLength;
        if (self.pendingClose)
            throw new Error("Writing a closing file");

        // Direct-write fast path: for large writes to a region with no cached
        // pages, write straight to disk, skipping the buff->page copy and the
        // deferred page flush. Any cached page in range (even clean) would go
        // stale after a direct write, so we fall back to the cached path then.
        // ArrayBuffer.isView gate: fd.write needs a real TypedArray/DataView; a
        // BigBuffer (paged, not a view) must use the cached path.
        if (buff.byteLength >= self.directWriteThreshold && ArrayBuffer.isView(buff) && !self._rangeHasCachedPages(pos, buff.byteLength)) {
            let done = 0;
            while (done < buff.byteLength) {
                const { bytesWritten } = await self.fd.write(buff, done, buff.byteLength - done, pos + done);
                if (bytesWritten === 0) break;   // should not happen
                done += bytesWritten;
            }
            const lastPage = Math.floor((pos + buff.byteLength - 1) / self.pageSize);
            if (lastPage + 1 > self.totalPages) self.totalPages = lastPage + 1;
            return;
        }

        const firstPage = Math.floor(pos / self.pageSize);
        const lastPage = Math.floor((pos + buff.byteLength -1) / self.pageSize);

        const pagePromises = [];
        for (let i=firstPage; i<=lastPage; i++) pagePromises.push(self._loadPage(i));
        self._triggerLoad();

        let p = firstPage;
        let o = pos % self.pageSize;
        let r = buff.byteLength;
        while (r>0) {
            await pagePromises[p-firstPage];
            const l = (o+r > self.pageSize) ? (self.pageSize -o) : r;
            const srcView = buff.slice( buff.byteLength - r, buff.byteLength - r + l);
            const dstView = new Uint8Array(self.pages[p].buff.buffer, o, l);
            dstView.set(srcView);
            self.pages[p].dirty = true;
            self.pages[p].pendingOps --;
            self.pages[p].size = Math.max(o+l, self.pages[p].size);
            if (p>=self.totalPages) {
                self.totalPages = p+1;
            }
            r = r-l;
            p ++;
            o = 0;
            if (!self.writing) setImmediate(self._triggerWrite.bind(self));
        }
    }

    async read(len, pos) {
        const self = this;
        let buff = new Uint8Array(len);
        await self.readToBuffer(buff, 0, len, pos);

        return buff;
    }

    // Iterate the actually-cached pages (usually few) rather than every page
    // index in [firstPage, lastPage], so the check stays O(cached pages) even
    // for very large ranges / small page sizes.
    _rangeHasDirtyPages(pos, len) {
        const firstPage = Math.floor(pos / this.pageSize);
        const lastPage = Math.floor((pos + len - 1) / this.pageSize);
        for (const k of Object.keys(this.pages)) {
            const p = +k;
            if (p >= firstPage && p <= lastPage) {
                const page = this.pages[p];
                if (page.dirty || page.writing) return true;
            }
        }
        return false;
    }

    async readToBuffer(buffDst, offset, len, pos) {
        if (len == 0) {
            return;
        }
        const self = this;
        if (self.error) throw self.error;
        if (typeof pos == "undefined") pos = self.pos;
        self.pos = pos+len;
        if (self.pendingClose)
            throw new Error("Reading a closing file");

        // Direct-read fast path: for large reads with no overlapping unwritten
        // (dirty) pages, copy straight from disk into the destination buffer.
        // This skips the page cache and the page->destination copy it incurs,
        // which dominates large sequential reads (e.g. zkey/ptau sections).
        // ArrayBuffer.isView gate: the direct path hands buffDst to fd.read, which
        // needs a real TypedArray/DataView. A BigBuffer (paged, not a view) must
        // go through the cached path, which copies into it via its own .set().
        if (len >= self.directReadThreshold && ArrayBuffer.isView(buffDst) && !self._rangeHasDirtyPages(pos, len)) {
            let toRead = (pos + len > self.totalSize) ? (self.totalSize - pos) : len;
            if (toRead < 0) toRead = 0;
            let done = 0;
            while (done < toRead) {
                const { bytesRead } = await self.fd.read(buffDst, offset + done, toRead - done, pos + done);
                if (bytesRead === 0) break;   // EOF
                done += bytesRead;
            }
            return;
        }

        if (len > self.pageSize*self.maxPagesLoaded*0.8) {
            const cacheSize = Math.floor(len * 1.1);
            this.maxPagesLoaded = Math.floor( cacheSize / self.pageSize)+1;
        }
        const firstPage = Math.floor(pos / self.pageSize);
        const lastPage = Math.floor((pos + len -1) / self.pageSize);

        const pagePromises = [];
        for (let i=firstPage; i<=lastPage; i++) pagePromises.push(self._loadPage(i));

        self._triggerLoad();

        let p = firstPage;
        let o = pos % self.pageSize;
        // Remaining bytes to read (clamped to EOF: a read past the end of a
        // truncated/short file reads fewer bytes than requested).
        let r = pos + len > self.totalSize ? len - (pos + len - self.totalSize): len;
        // Bytes already written to buffDst -- tracked independently of `r`
        // (which shrinks on EOF-clamping) so the destination offset stays
        // correct. Previously computed as `offset + len - r`: with `r`
        // pre-clamped below `len`, that put the first bytes read at a
        // nonzero offset instead of the real EOF-truncated tail, silently
        // shifting valid data to the wrong position in the output buffer.
        let done = 0;
        while (r>0) {
            await pagePromises[p - firstPage];
            self.__statusPage("After Await (read): ", p);

            // bytes to copy from this page
            const l = (o+r > self.pageSize) ? (self.pageSize -o) : r;
            const srcView = new Uint8Array(self.pages[p].buff.buffer, self.pages[p].buff.byteOffset + o, l);
            buffDst.set(srcView, offset+done);
            self.pages[p].pendingOps --;

            self.__statusPage("After Op done: ", p);

            r = r-l;
            done = done+l;
            p ++;
            o = 0;
            if (self.pendingLoads.length>0) setImmediate(self._triggerLoad.bind(self));
        }

        this.pos = pos + len;

    }


    _tryClose() {
        const self = this;
        if (!self.pendingClose) return;
        if (self.error) {
            self.pendingCloseReject(self.error);
            return;
        }
        const p = self._getDirtyPage();
        if ((p>=0) || (self.writing) || (self.reading) || (self.pendingLoads.length>0)) return;
        self.pendingClose();
    }

    close() {
        const self = this;
        if (self.pendingClose)
            throw new Error("Closing the file twice");
        return new Promise((resolve, reject) => {
            self.pendingClose = resolve;
            self.pendingCloseReject = reject;
            self._tryClose();
        }).then(()=> {
            self.fd.close();
        }, (err) => {
            self.fd.close();
            throw (err);
        });
    }

    async discard() {
        const self = this;
        await self.close();
        await fs__default["default"].promises.unlink(this.fileName);
    }

    async writeULE32(v, pos) {
        const self = this;
        const tmpBuff32 = new Uint8Array(4);
        const tmpBuff32v = new DataView(tmpBuff32.buffer);

        tmpBuff32v.setUint32(0, v, true);

        await self.write(tmpBuff32, pos);
    }

    async writeUBE32(v, pos) {
        const self = this;

        const tmpBuff32 = new Uint8Array(4);
        const tmpBuff32v = new DataView(tmpBuff32.buffer);

        tmpBuff32v.setUint32(0, v, false);

        await self.write(tmpBuff32, pos);
    }


    async writeULE64(v, pos) {
        const self = this;

        const tmpBuff64 = new Uint8Array(8);
        const tmpBuff64v = new DataView(tmpBuff64.buffer);

        tmpBuff64v.setUint32(0, v & 0xFFFFFFFF, true);
        tmpBuff64v.setUint32(4, Math.floor(v / 0x100000000) , true);

        await self.write(tmpBuff64, pos);
    }

    async readULE32(pos) {
        const self = this;
        const b = await self.read(4, pos);

        const view = new Uint32Array(b.buffer);

        return view[0];
    }

    async readUBE32(pos) {
        const self = this;
        const b = await self.read(4, pos);

        const view = new DataView(b.buffer);

        return view.getUint32(0, false);
    }

    async readULE64(pos) {
        const self = this;
        const b = await self.read(8, pos);

        const view = new Uint32Array(b.buffer);

        return view[1] * 0x100000000 + view[0];
    }

    async readString(pos) {
        const self = this;

        if (self.pendingClose) {
            throw new Error("Reading a closing file");
        }

        let currentPosition = typeof pos == "undefined" ? self.pos : pos;
        let currentPage = Math.floor(currentPosition / self.pageSize);

        let endOfStringFound = false;
        let str = "";

        while (!endOfStringFound) {
            //Read page
            let pagePromise = self._loadPage(currentPage);
            self._triggerLoad();
            await pagePromise;
            self.__statusPage("After Await (read): ", currentPage);

            let offsetOnPage = currentPosition % self.pageSize;

            const dataArray = new Uint8Array(
                self.pages[currentPage].buff.buffer,
                self.pages[currentPage].buff.byteOffset + offsetOnPage,
                self.pageSize - offsetOnPage
            );

            let indexEndOfString = dataArray.findIndex(element => element === 0);
            endOfStringFound = indexEndOfString !== -1;

            if (endOfStringFound) {
                str += new TextDecoder().decode(dataArray.slice(0, indexEndOfString));
                self.pos = currentPage * this.pageSize + offsetOnPage + indexEndOfString + 1;
            } else {
                str += new TextDecoder().decode(dataArray);
                self.pos = currentPage * this.pageSize + offsetOnPage + dataArray.length;
            }

            self.pages[currentPage].pendingOps--;
            self.__statusPage("After Op done: ", currentPage);

            currentPosition = self.pos;
            currentPage++;

            if (self.pendingLoads.length > 0) setImmediate(self._triggerLoad.bind(self));
        }

        return str;
    }
}

function createNew$1(o) {
    const initialSize = o.initialSize || 1<<20;
    const fd = new MemFile();
    fd.o = o;
    fd.o.data = new Uint8Array(initialSize);
    fd.allocSize = initialSize;
    fd.totalSize = 0;
    fd.readOnly = false;
    fd.pos = 0;
    return fd;
}

function readExisting$4(o) {
    const fd = new MemFile();
    fd.o = o;
    fd.allocSize = o.data.byteLength;
    fd.totalSize = o.data.byteLength;
    fd.readOnly = true;
    fd.pos = 0;
    return fd;
}

function readWriteExisting$2(o) {
    const fd = new MemFile();
    fd.o = o;
    fd.allocSize = o.data.byteLength;
    fd.totalSize = o.data.byteLength;
    fd.readOnly = false;
    fd.pos = 0;
    return fd;
}

const tmpBuff32$1 = new Uint8Array(4);
const tmpBuff32v$1 = new DataView(tmpBuff32$1.buffer);
const tmpBuff64$1 = new Uint8Array(8);
const tmpBuff64v$1 = new DataView(tmpBuff64$1.buffer);

class MemFile {

    constructor() {
        this.pageSize = 1 << 14;  // for compatibility
    }

    _resizeIfNeeded(newLen) {
        if (newLen > this.allocSize) {
            const newAllocSize = Math.max(
                this.allocSize + (1 << 20),
                Math.floor(this.allocSize * 1.1),
                newLen
            );
            const newData = new Uint8Array(newAllocSize);
            newData.set(this.o.data);
            this.o.data = newData;
            this.allocSize = newAllocSize;
        }
    }

    async write(buff, pos) {
        const self =this;
        if (typeof pos == "undefined") pos = self.pos;
        if (this.readOnly) throw new Error("Writing a read only file");

        this._resizeIfNeeded(pos + buff.byteLength);

        this.o.data.set(buff.slice(), pos);

        if (pos + buff.byteLength > this.totalSize) this.totalSize = pos + buff.byteLength;

        this.pos = pos + buff.byteLength;
    }

    async readToBuffer(buffDest, offset, len, pos) {
        const self = this;
        if (typeof pos == "undefined") pos = self.pos;
        if (this.readOnly) {
            if (pos + len > this.totalSize) throw new Error("Reading out of bounds");
        }
        this._resizeIfNeeded(pos + len);

        const buffSrc = new Uint8Array(this.o.data.buffer, this.o.data.byteOffset + pos, len);

        buffDest.set(buffSrc, offset);

        this.pos = pos + len;
    }

    async read(len, pos) {
        const self = this;

        const buff = new Uint8Array(len);
        await self.readToBuffer(buff, 0, len, pos);

        return buff;
    }

    close() {
        if (this.o.data.byteLength != this.totalSize) {
            this.o.data = this.o.data.slice(0, this.totalSize);
        }
    }

    async discard() {
    }


    async writeULE32(v, pos) {
        const self = this;

        tmpBuff32v$1.setUint32(0, v, true);

        await self.write(tmpBuff32$1, pos);
    }

    async writeUBE32(v, pos) {
        const self = this;

        tmpBuff32v$1.setUint32(0, v, false);

        await self.write(tmpBuff32$1, pos);
    }


    async writeULE64(v, pos) {
        const self = this;

        tmpBuff64v$1.setUint32(0, v & 0xFFFFFFFF, true);
        tmpBuff64v$1.setUint32(4, Math.floor(v / 0x100000000) , true);

        await self.write(tmpBuff64$1, pos);
    }


    async readULE32(pos) {
        const self = this;
        const b = await self.read(4, pos);

        const view = new Uint32Array(b.buffer);

        return view[0];
    }

    async readUBE32(pos) {
        const self = this;
        const b = await self.read(4, pos);

        const view = new DataView(b.buffer);

        return view.getUint32(0, false);
    }

    async readULE64(pos) {
        const self = this;
        const b = await self.read(8, pos);

        const view = new Uint32Array(b.buffer);

        return view[1] * 0x100000000 + view[0];
    }

    async readString(pos) {
        const self = this;

        let currentPosition = typeof pos == "undefined" ? self.pos : pos;

        if (currentPosition > this.totalSize) {
            if (this.readOnly) {
                throw new Error("Reading out of bounds");
            }
            this._resizeIfNeeded(pos);
        }
        const dataArray = new Uint8Array(
            self.o.data.buffer,
            currentPosition,
            this.totalSize - currentPosition
        );

        let indexEndOfString = dataArray.findIndex(element => element === 0);
        let endOfStringFound = indexEndOfString !== -1;

        let str = "";
        if (endOfStringFound) {
            str = new TextDecoder().decode(dataArray.slice(0, indexEndOfString));
            self.pos = currentPosition + indexEndOfString + 1;
        } else {
            self.pos = currentPosition;
        }
        return str;
    }
}

const PAGE_SIZE = 1<<22;

function createNew(o) {
    const initialSize = o.initialSize || 0;
    const fd = new BigMemFile();
    fd.o = o;
    const nPages = initialSize ? Math.floor((initialSize - 1) / PAGE_SIZE)+1 : 0;
    fd.o.data = [];
    for (let i=0; i<nPages-1; i++) {
        fd.o.data.push( new Uint8Array(PAGE_SIZE));
    }
    if (nPages) fd.o.data.push( new Uint8Array(initialSize - PAGE_SIZE*(nPages-1)));
    fd.totalSize = 0;
    fd.readOnly = false;
    fd.pos = 0;
    return fd;
}

function readExisting$3(o) {
    const fd = new BigMemFile();
    fd.o = o;
    fd.totalSize = (o.data.length-1)* PAGE_SIZE + o.data[o.data.length-1].byteLength;
    fd.readOnly = true;
    fd.pos = 0;
    return fd;
}

function readWriteExisting$1(o) {
    const fd = new BigMemFile();
    fd.o = o;
    fd.totalSize = (o.data.length-1)* PAGE_SIZE + o.data[o.data.length-1].byteLength;
    fd.readOnly = false;
    fd.pos = 0;
    return fd;
}

const tmpBuff32 = new Uint8Array(4);
const tmpBuff32v = new DataView(tmpBuff32.buffer);
const tmpBuff64 = new Uint8Array(8);
const tmpBuff64v = new DataView(tmpBuff64.buffer);

class BigMemFile {

    constructor() {
        this.pageSize = 1 << 14;  // for compatibility
    }

    _resizeIfNeeded(newLen) {

        if (newLen <= this.totalSize) return;

        if (this.readOnly) throw new Error("Reading out of file bounds");

        const nPages = Math.floor((newLen - 1) / PAGE_SIZE)+1;
        for (let i= Math.max(this.o.data.length-1, 0); i<nPages; i++) {
            const newSize = i<nPages-1 ? PAGE_SIZE : newLen - (nPages-1)*PAGE_SIZE;
            const p = new Uint8Array(newSize);
            if (i == this.o.data.length-1) p.set(this.o.data[i]);
            this.o.data[i] = p;
        }
        this.totalSize = newLen;
    }

    async write(buff, pos) {
        const self =this;
        if (typeof pos == "undefined") pos = self.pos;
        if (this.readOnly) throw new Error("Writing a read only file");

        this._resizeIfNeeded(pos + buff.byteLength);

        const firstPage = Math.floor(pos / PAGE_SIZE);

        let p = firstPage;
        let o = pos % PAGE_SIZE;
        let r = buff.byteLength;
        while (r>0) {
            const l = (o+r > PAGE_SIZE) ? (PAGE_SIZE -o) : r;
            const srcView = buff.slice(buff.byteLength - r, buff.byteLength - r + l);
            const dstView = new Uint8Array(self.o.data[p].buffer, o, l);
            dstView.set(srcView);
            r = r-l;
            p ++;
            o = 0;
        }

        this.pos = pos + buff.byteLength;
    }

    async readToBuffer(buffDst, offset, len, pos) {
        const self = this;
        if (typeof pos == "undefined") pos = self.pos;
        if (this.readOnly) {
            if (pos + len > this.totalSize) throw new Error("Reading out of bounds");
        }
        this._resizeIfNeeded(pos + len);

        const firstPage = Math.floor(pos / PAGE_SIZE);

        let p = firstPage;
        let o = pos % PAGE_SIZE;
        // Remaining bytes to read
        let r = len;
        while (r>0) {
            // bytes to copy from this page
            const l = (o+r > PAGE_SIZE) ? (PAGE_SIZE -o) : r;
            const srcView = new Uint8Array(self.o.data[p].buffer, o, l);
            buffDst.set(srcView, offset+len-r);
            r = r-l;
            p ++;
            o = 0;
        }

        this.pos = pos + len;
    }

    async read(len, pos) {
        const self = this;
        const buff = new Uint8Array(len);

        await self.readToBuffer(buff, 0, len, pos);

        return buff;
    }

    close() {
    }

    async discard() {
    }


    async writeULE32(v, pos) {
        const self = this;

        tmpBuff32v.setUint32(0, v, true);

        await self.write(tmpBuff32, pos);
    }

    async writeUBE32(v, pos) {
        const self = this;

        tmpBuff32v.setUint32(0, v, false);

        await self.write(tmpBuff32, pos);
    }


    async writeULE64(v, pos) {
        const self = this;

        tmpBuff64v.setUint32(0, v & 0xFFFFFFFF, true);
        tmpBuff64v.setUint32(4, Math.floor(v / 0x100000000) , true);

        await self.write(tmpBuff64, pos);
    }


    async readULE32(pos) {
        const self = this;
        const b = await self.read(4, pos);

        const view = new Uint32Array(b.buffer);

        return view[0];
    }

    async readUBE32(pos) {
        const self = this;
        const b = await self.read(4, pos);

        const view = new DataView(b.buffer);

        return view.getUint32(0, false);
    }

    async readULE64(pos) {
        const self = this;
        const b = await self.read(8, pos);

        const view = new Uint32Array(b.buffer);

        return view[1] * 0x100000000 + view[0];
    }

    async readString(pos) {
        const self = this;
        const fixedSize = 2048;

        let currentPosition = typeof pos == "undefined" ? self.pos : pos;

        if (currentPosition > this.totalSize) {
            if (this.readOnly) {
                throw new Error("Reading out of bounds");
            }
            this._resizeIfNeeded(pos);
        }

        let endOfStringFound = false;
        let str = "";

        while (!endOfStringFound) {
            let currentPage = Math.floor(currentPosition / PAGE_SIZE);
            let offsetOnPage = currentPosition % PAGE_SIZE;

            if (self.o.data[currentPage] === undefined) {
                throw new Error("ERROR");
            }

            let readLength = Math.min(fixedSize, self.o.data[currentPage].length - offsetOnPage);
            const dataArray = new Uint8Array(self.o.data[currentPage].buffer, offsetOnPage, readLength);

            let indexEndOfString = dataArray.findIndex(element => element === 0);
            endOfStringFound = indexEndOfString !== -1;

            if (endOfStringFound) {
                str += new TextDecoder().decode(dataArray.slice(0, indexEndOfString));
                self.pos = currentPage * PAGE_SIZE + offsetOnPage + indexEndOfString + 1;
            } else {
                str += new TextDecoder().decode(dataArray);
                self.pos = currentPage * PAGE_SIZE + offsetOnPage + dataArray.length;
            }

            currentPosition = self.pos;
        }
        return str;
    }
}

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

const DEFAULT_CACHE_SIZE$1 = 1 << 20;
const DEFAULT_PAGE_SIZE$1 = 1 << 13;

class RangeFile {

    constructor(readRangeInto, totalSize, cacheSize, pageSize) {
        this.readRangeInto = readRangeInto;
        this.totalSize = totalSize;
        this.pos = 0;
        this.pageSize = pageSize || DEFAULT_PAGE_SIZE$1;
        this.maxPagesLoaded = Math.floor((cacheSize || DEFAULT_CACHE_SIZE$1) / this.pageSize) + 1;
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

// Read-only file over HTTP(S) using Range requests.

async function readExisting$2(o) {
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
            return readExisting$4({ type: "mem", data: new Uint8Array(0) });
        }
        return await readFullyToMem(url);
    }

    // 200: the server ignored Range and sent the whole file; reuse this body.
    const data = new Uint8Array(await probe.arrayBuffer());
    return readExisting$4({ type: "mem", data: data });
}

async function readFullyToMem(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status + " fetching " + url);
    const data = new Uint8Array(await res.arrayBuffer());
    return readExisting$4({ type: "mem", data: data });
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

// Read-only file over a Blob/File (e.g. a browser <input type="file">

function readExisting$1(o) {
    const blob = o.blob;
    const readRangeInto = async function (dst, dstOffset, pos, len) {
        const ab = await blob.slice(pos, pos + len).arrayBuffer();
        if (ab.byteLength !== len) {
            throw new Error("short blob read (" + ab.byteLength + "/" + len + " bytes at " + pos + ")");
        }
        dst.set(new Uint8Array(ab), dstOffset);
    };
    return new RangeFile(readRangeInto, blob.size, o.cacheSize, o.pageSize);
}

const DEFAULT_CACHE_SIZE = (1 << 16);
const DEFAULT_PAGE_SIZE = (1 << 13);

// Robust Node detection that never throws (unlike `process.browser`, which is a
// webpack-ism and is undefined under Vite/esbuild/SES).
const isNode = typeof process !== "undefined" && process.versions != null && process.versions.node != null;


async function createOverride(o, b, c) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b || DEFAULT_CACHE_SIZE,
            pageSize: c || DEFAULT_PAGE_SIZE
        };
    }
    if (o.type == "file") {
        return await open(o.fileName, constants.O_TRUNC | constants.O_CREAT | constants.O_RDWR, o.cacheSize, o.pageSize);
    } else if (o.type == "mem") {
        return createNew$1(o);
    } else if (o.type == "bigMem") {
        return createNew(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

function createNoOverride(o, b, c) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b || DEFAULT_CACHE_SIZE,
            pageSize: c || DEFAULT_PAGE_SIZE
        };
    }
    if (o.type == "file") {
        return open(o.fileName, constants.O_TRUNC | constants.O_CREAT | constants.O_RDWR | constants.O_EXCL, o.cacheSize, o.pageSize);
    } else if (o.type == "mem") {
        return createNew$1(o);
    } else if (o.type == "bigMem") {
        return createNew(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

async function readExisting(o, b, c) {
    if (o instanceof Uint8Array) {
        o = {
            type: "mem",
            data: o
        };
    }
    if (typeof Blob !== "undefined" && o instanceof Blob) {
        o = {
            type: "blob",
            blob: o,
            cacheSize: b,
            pageSize: c
        };
    }
    if (typeof o === "string") {
        // URLs (and, in the browser, any string -- historically fetched
        // whole) go through the http backend: it streams via Range requests
        // when the server supports them and falls back to buffering the
        // full body (the previous behavior) when it does not.
        if (!isNode || /^https?:\/\//i.test(o)) {
            o = {
                type: "http",
                url: o,
                cacheSize: b,
                pageSize: c
            };
        } else {
            o = {
                type: "file",
                fileName: o,
                cacheSize: b || DEFAULT_CACHE_SIZE,
                pageSize: c || DEFAULT_PAGE_SIZE
            };
        }
    }
    if (o.type == "file") {
        return await open(o.fileName, constants.O_RDONLY, o.cacheSize, o.pageSize);
    } else if (o.type == "mem") {
        return await readExisting$4(o);
    } else if (o.type == "bigMem") {
        return await readExisting$3(o);
    } else if (o.type == "http") {
        return await readExisting$2(o);
    } else if (o.type == "blob") {
        return readExisting$1(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

function readWriteExisting(o, b, c) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b || DEFAULT_CACHE_SIZE,
            pageSize: c || DEFAULT_PAGE_SIZE
        };
    }
    if (o.type == "file") {
        return open(o.fileName, constants.O_CREAT | constants.O_RDWR, o.cacheSize, o.pageSize);
    } else if (o.type == "mem") {
        return readWriteExisting$2(o);
    } else if (o.type == "bigMem") {
        return readWriteExisting$1(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

function readWriteExistingOrCreate(o, b, c) {
    if (typeof o === "string") {
        o = {
            type: "file",
            fileName: o,
            cacheSize: b || DEFAULT_CACHE_SIZE,
            pageSize: c || DEFAULT_PAGE_SIZE
        };
    }
    if (o.type == "file") {
        return open(o.fileName, constants.O_CREAT | constants.O_RDWR | constants.O_EXCL, o.cacheSize);
    } else if (o.type == "mem") {
        return readWriteExisting$2(o);
    } else if (o.type == "bigMem") {
        return readWriteExisting$1(o);
    } else {
        throw new Error("Invalid FastFile type: "+o.type);
    }
}

exports.createNoOverride = createNoOverride;
exports.createOverride = createOverride;
exports.readExisting = readExisting;
exports.readWriteExisting = readWriteExisting;
exports.readWriteExistingOrCreate = readWriteExistingOrCreate;
