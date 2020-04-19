
const fs=require("fs");
const assert = require("assert");

module.exports.createOverride = function createOverride(fileName, cacheSize) {
    return open(fileName, "w+", cacheSize);
};

module.exports.createNoOverride = function createNoOverride(fileName, cacheSize) {
    return open(fileName, "wx+", cacheSize);
};

module.exports.readExisting = function readExisting(fileName, cacheSize) {
    return open(fileName, "r", cacheSize);
};

module.exports.readWriteExisting = function readExisting(fileName, cacheSize) {
    return open(fileName, "a+", cacheSize);
};

module.exports.readWriteExistingOrCreate = function readExisting(fileName,cacheSize) {
    return open(fileName, "ax+", cacheSize);
};

module.exports.open = open;

async function open(fileName, openFlags, cacheSize) {
    cacheSize = cacheSize || 4096*1000;
    assert(["w+", "wx+", "r", "ax+", "a+"].indexOf(openFlags) >= 0);
    const fd =await fs.promises.open(fileName, openFlags);

    const stats = await fd.stat();

    return  new FastFile(fd, stats, cacheSize);
}

class FastFile {

    constructor(fd, stats, cacheSize) {
        this.fd = fd;
        this.pos = 0;
        this.pageBits = 8;
        this.pageSize = (1 << this.pageBits);
        while (this.pageSize < stats.blksize) {
            this.pageBits ++;
            this.pageSize *= 2;
        }
        this.pageMask = this.pageSize -1;
        this.totalSize = stats.size;
        this.totalPages = Math.floor((stats.size -1) / this.pageSize)+1;
        this.maxPagesLoaded = Math.floor( cacheSize / this.pageSize);
        this.pages = {};
        this.pendingLoads = [];
        this.writing = false;
        this.reading = false;
    }

    _loadPage(p) {
        const self = this;
        return new Promise((resolve, reject)=> {
            self.pendingLoads.push({
                page: p,
                resolve: resolve,
                reject: reject
            });
            self._triggerLoad();
        });
    }


    _triggerLoad() {
        const self = this;
        processPendingLoads();
        if (self.pendingLoads.length == 0) return;
        if (Object.keys(self.pages).length >= self.maxPagesLoaded) {
            const dp = getDeletablePage();
            if (dp<0) return;   // No sizes available
            delete self.pages[dp];
        }
        const load = self.pendingLoads.shift();
        if (load.page>=self.totalPages) {
            self.pages[load.page] = {
                dirty: false,
                buff: Buffer.alloc(self.pageSize),
                pendingOps: 1,
                size: 0
            };
            load.resolve();
            setImmediate(self._triggerLoad.bind(self));
            return;
        }
        if (self.reading) return;  // Only one read at a time.

        self.reading = true;
        const page = {
            dirty: false,
            buff: Buffer.alloc(self.pageSize),
            pendingOps: 1,
            size: 0
        };
        self.fd.read(page.buff, 0, self.pageSize, load.page*self.pageSize).then((res)=> {
            page.size = res.bytesRead;
            self.pages[load.page] = page;
            self.reading = false;
            load.resolve();
            setImmediate(self._triggerLoad.bind(self));
        }, (err) => {
            load.reject(err);
        });

        function processPendingLoads() {
            const newPendingLoads = [];
            for (let i=0; i<self.pendingLoads.length; i++) {
                const load = self.pendingLoads[i];
                if (typeof self.pages[load.page] != "undefined") {
                    self.pages[load.page].pendingOps ++;
                    load.resolve();
                } else {
                    newPendingLoads.push(load);
                }
            }
            self.pendingLoads = newPendingLoads;
        }

        function getDeletablePage() {
            for (let p in self.pages) {
                const page = self.pages[p];
                if ((page.dirty == false)&&(page.pendingOps==0)) return p;
            }
            return -1;
        }
    }

    _triggerWrite() {
        const self = this;
        if (self.writing) return;
        const p = self._getDirtyPage();
        if (p<0) {
            if (self.pendingClose) self.pendingClose();
            return;
        }
        self.writing=true;
        self.pages[p].dirty = false;
        self.fd.write(self.pages[p].buff, 0, self.pages[p].size, p*self.pageSize).then(() => {
            self.writing = false;
            setImmediate(self._triggerWrite.bind(self));
            setImmediate(self._triggerLoad.bind(self));
        }, (err) => {
            self.error = err;
            self._tryClose();
        });

    }

    _getDirtyPage() {
        for (let p in this.pages) {
            if (this.pages[p].dirty) return p;
        }
        return -1;
    }

    async write(buff, pos) {
        const self = this;
        assert(!self.pendingClose);
        const firstPage = pos >> self.pageBits;
        const lastPage = (pos+buff.length-1) >> self.pageBits;

        for (let i=firstPage; i<=lastPage; i++) await self._loadPage(i);

        let p = firstPage;
        let o = pos & self.pageMask;
        let r = buff.length;
        while (r>0) {
            const l = (o+r > self.pageSize) ? (self.pageSize -o) : r;
            buff.copy(self.pages[p].buff, o, buff.length - r, buff.length-r+l);
            self.pages[p].dirty = true;
            self.pages[p].pendingOps --;
            self.pages[p].size = Math.max(o+l, self.pages[p].size);
            if (p>=self.totalPages) {
                self.totalPages = p+1;
                self.totalSize = (self.totalPages - 1)* self.pageSize + self.pages[p].size;
            }
            r = r-l;
            p ++;
            o = 0;
        }
        self._triggerWrite();
    }

    async read(pos, len) {
        const self = this;
        assert(!self.pendingClose);
        const firstPage = pos >> self.pageBits;
        const lastPage = (pos+len-1) >> self.pageBits;

        for (let i=firstPage; i<=lastPage; i++) await self._loadPage(i);

        let buff = Buffer.allocUnsafe(len);
        let p = firstPage;
        let o = pos & self.pageMask;
        let r = pos + len > self.totalSize ? len - (pos + len - self.totalSize): len;
        while (r>0) {
            const l = (o+r > self.pageSize) ? (self.pageSize -o) : r;
            self.pages[p].buff.copy(buff, buff.length -r, o, o +l);
            self.pages[p].pendingOps --;
            r = r-l;
            p ++;
            o = 0;
        }
        self._triggerLoad();
        return buff;
    }

    _tryClose() {
        const self = this;
        if (!self.pendingClose) return;
        if (self.error) {
            self.pendingCloseReject(self.error);
        }
        const p = self._getDirtyPage();
        if ((p>=0) || (self.writing) || (self.reading) || (self.pendingLoads.length>0)) return;
        self.pendingClose();
    }

    close() {
        const self = this;
        assert(!self.pendingClose);
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

}
