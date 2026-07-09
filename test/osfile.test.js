import fs from "fs";
import * as testUtils from "./testUtils.js";
import * as fastFile from "../src/fastfile.js";

import { BigBuffer } from "ffjavascript";

import assert from "assert";
import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";

chai.use(chaiAsPromised);
const expect = chai.expect;

describe("fastfile testing suite for osfile", function () {
    let fileName = "test_osfile.bin";

    this.timeout(100000);

    let str1 = "0123456789";
    let str2 = "Hi_there";
    let str3 = "/!!--::**";

    it("should read valid strings from file", async () => {
        let fd = await fastFile.createOverride(fileName);

        await testUtils.writeFakeStringToFile(fd, fd.pageSize - 11);

        await testUtils.writeStringToFile(fd, str1);
        await testUtils.writeStringToFile(fd, str2);
        await testUtils.writeStringToFile(fd, str3);

        let str = await fd.readString(fd.pageSize - 11);
        assert.strictEqual(str, str1);

        str = await fd.readString();
        assert.strictEqual(str, str2);

        str = await fd.readString();
        assert.strictEqual(str, str3);

        await fd.close();

        assert(fs.existsSync(fileName));

        await fs.promises.unlink(fileName);
    });

    it("should throw error when try to read a closed file", async () => {
        let fd = await fastFile.createOverride(fileName);
        await fd.close();
        expect(fd.readString(0)).to.be.rejectedWith("Reading a closing file");
        await fs.promises.unlink(fileName);
    });

    // Regression: the direct-io fast paths hand the buffer to fd.read/fd.write,
    // which require a real TypedArray. A BigBuffer (paged, not an ArrayBufferView)
    // must fall back to the cached path. A direct read into a BigBuffer used to
    // silently leave it unfilled -> corrupted ptau/zkey sections. The read must be
    // >= directReadThreshold (1MB) so it would take the direct path if not gated.
    it("should read a large section into a BigBuffer (direct-io must not bypass it)", async () => {
        const N = 1 << 21; // 2 MB > directReadThreshold
        const ref = new Uint8Array(N);
        for (let i = 0; i < N; i++) ref[i] = (i * 131 + 7) & 0xff;

        let fd = await fastFile.createOverride(fileName);
        await fd.write(ref, 0);
        await fd.close();

        fd = await fastFile.readExisting(fileName);
        assert(!ArrayBuffer.isView(new BigBuffer(8)), "BigBuffer must not be an ArrayBufferView");
        const bb = new BigBuffer(N);
        await fd.readToBuffer(bb, 0, N, 0);
        await fd.close();

        assert(Buffer.from(bb.slice(0, N)).equals(Buffer.from(ref)), "BigBuffer read does not match file");
        await fs.promises.unlink(fileName);
    });

    it("should write a large section from a BigBuffer (direct-io must not bypass it)", async () => {
        const N = 1 << 21; // 2 MB > directWriteThreshold
        const ref = new Uint8Array(N);
        for (let i = 0; i < N; i++) ref[i] = (i * 197 + 13) & 0xff;
        const bb = new BigBuffer(N);
        bb.set(ref, 0);

        let fd = await fastFile.createOverride(fileName);
        await fd.write(bb, 0);
        await fd.close();

        const onDisk = fs.readFileSync(fileName);
        assert.strictEqual(onDisk.length, N);
        assert(onDisk.equals(Buffer.from(ref)), "BigBuffer write does not match disk");
        await fs.promises.unlink(fileName);
    });

    // Regression: readToBuffer's cached-page path (reads below directReadThreshold,
    // i.e. the common case for most zkey/ptau/wtns sections) computed the
    // destination-buffer offset as `offset + len - r`, where `r` had already been
    // clamped to the EOF-truncated byte count. That put the on-disk bytes at a
    // nonzero offset in the output instead of at the start, and left the START of
    // the buffer as zeros instead of the tail -- valid bytes silently shifted to
    // the wrong position rather than the read cleanly failing or zero-padding
    // only the truncated tail. This simulates a corrupted/incomplete file (a
    // section header claims more bytes than the file actually has).
    it("readToBuffer past EOF on a truncated file places real bytes at the start, not shifted (below directReadThreshold)", async () => {
        const declaredLen = 2000; // < directReadThreshold (1MB): exercises the cached-page path
        const actualLen = 1000;   // how many bytes actually exist past `pos`
        const pos = 24;           // simulate a section starting after a small header

        let fd = await fastFile.createOverride(fileName);
        await fd.write(new Uint8Array(pos + actualLen).fill(0xAB), 0);
        await fd.close();

        assert.strictEqual(fs.statSync(fileName).size, pos + actualLen);

        fd = await fastFile.readExisting(fileName);
        const buff = await fd.read(declaredLen, pos);
        await fd.close();

        assert.strictEqual(buff.length, declaredLen);
        // The real on-disk bytes must land at the START of the buffer...
        for (let i = 0; i < actualLen; i++) {
            assert.strictEqual(buff[i], 0xAB, `expected real data at index ${i}`);
        }
        // ...and only the truncated TAIL (bytes that don't exist on disk) is zero.
        for (let i = actualLen; i < declaredLen; i++) {
            assert.strictEqual(buff[i], 0, `expected zero padding at index ${i}`);
        }
        await fs.promises.unlink(fileName);
    });

    // Regression: when a page read failed, only the FIRST waiter was rejected;
    // co-readers queued on page.loading hung forever, and the page stayed
    // cached with a dead loading list so every future reader of it hung too.
    it("a failed page read rejects all waiters and the page recovers", async () => {
        fs.writeFileSync(fileName, new Uint8Array(1 << 16).fill(0xab));
        const fd = await fastFile.readExisting(fileName, 1 << 20, 1 << 12);

        const realRead = fd.fd.read.bind(fd.fd);
        let failures = 1;
        fd.fd.read = (...args) => {
            if (failures > 0) { failures--; return Promise.reject(new Error("simulated EIO")); }
            return realRead(...args);
        };

        // Two concurrent readers of the same page: both must settle (reject
        // or, for the one that arrives after recovery, resolve) -- never hang.
        const r1 = await fd.read(64, 0).then(() => "resolved", () => "rejected");
        const r2 = await fd.read(64, 128).then(() => "resolved", () => "rejected");
        assert(r1 === "rejected" || r2 === "rejected", "at least one reader sees the EIO");

        // A later reader of the same page must succeed (page not poisoned).
        const b = await fd.read(64, 0);
        assert.strictEqual(b[0], 0xab);
        await fd.close();
        await fs.promises.unlink(fileName);
    });

    // Regression: a failed background page flush was only visible at close();
    // page.writing also stayed true, pinning the page. Subsequent writes/reads
    // must now fail fast and close() must reject.
    it("a failed background write surfaces on the next write and on close()", async () => {
        const fd = await fastFile.createOverride(fileName, 1 << 20, 1 << 12);

        const realWrite = fd.fd.write.bind(fd.fd);
        fd.fd.write = () => Promise.reject(new Error("simulated ENOSPC"));

        await fd.write(new Uint8Array(64).fill(1), 0); // dirty page; background flush fails
        await new Promise((resolve) => setTimeout(resolve, 50));

        await expect(fd.write(new Uint8Array(64).fill(2), 4096)).to.be.rejectedWith("simulated ENOSPC");
        await expect(fd.close()).to.be.rejectedWith("simulated ENOSPC");

        fd.fd.write = realWrite; // let the underlying fd close cleanly
        await fs.promises.unlink(fileName);
    });
});




