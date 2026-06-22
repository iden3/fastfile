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
});




