import * as fastFile from "../src/fastfile.js";

import assert from "assert";
import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";

chai.use(chaiAsPromised);
const expect = chai.expect;

function makeData(n) {
    const data = new Uint8Array(n);
    let x = 0x9E3779B9;
    for (let i = 0; i < n; i++) {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        data[i] = x & 0xFF;
    }
    return data;
}

describe("fastfile testing suite for blobfile", function () {
    this.timeout(100000);

    it("should read positioned ranges from a Blob", async () => {
        const data = makeData(1 << 18);
        const fd = await fastFile.readExisting(new Blob([data]));
        assert.strictEqual(fd.totalSize, data.length);

        const head = await fd.read(4, 0);
        assert.deepStrictEqual(Buffer.from(head), Buffer.from(data.slice(0, 4)));

        const big = new Uint8Array(100000);
        await fd.readToBuffer(big, 0, big.length, 30000);
        assert.deepStrictEqual(Buffer.from(big), Buffer.from(data.slice(30000, 130000)));

        const v = await fd.readULE64(1024);
        const dv = new DataView(data.buffer);
        assert.strictEqual(v, dv.getUint32(1028, true) * 0x100000000 + dv.getUint32(1024, true));

        await fd.close();
    });

    it("should reject reads out of bounds and any write", async () => {
        const fd = await fastFile.readExisting(new Blob([makeData(100)]));
        await expect(fd.read(8, 96)).to.be.rejectedWith(/out of bounds/);
        await expect(fd.write(new Uint8Array(4), 0)).to.be.rejectedWith(/read only/);
        await fd.close();
    });
});
