/* globals BigInt */
const assert = require("assert");
const fs = require("fs");

const fastFile = require("../src/fastfile");

const Scalar = require("ffjavascript").Scalar;
const F1Field = require("ffjavascript").F1Field;

const tmp = require("tmp-promise");


const q = Scalar.fromString("21888242871839275222246405745257275088548364400416034343698204186575808495617");
const F = new F1Field(q)

async function writeBigInt(f, n, pos) {
    const n8 = 32;
    const s = n.toString(16);
    const b = Buffer.from(s.padStart(n8*2, "0"), "hex");
    const buff = Buffer.allocUnsafe(b.length);
    for (let i=0; i<b.length; i++) buff[i] = b[b.length-1-i];

    await f.write(buff, pos);
}

async function readBigInt(f, pos) {
    const n8 = 32;

    const buff = await f.read(pos, n8);
    assert(buff.length == n8);
    const buffR = Buffer.allocUnsafe(n8);
    for (let i=0; i<n8; i++) buffR[i] = buff[n8-1-i];

    return BigInt("0x" + buffR.toString("hex"));
}

describe("fastfile test", function () {
    let fileName = "test.bin";
    this.timeout(1000000000);
    const values = {};

    it("should write a big file sequentially", async () => {
        fileName = await tmp.tmpName();

        fileName = "test.bin";

        console.log(fileName);
        const f = await fastFile.createOverride(fileName);
        for (let i=0; i<1000000; i++) {
            await writeBigInt(f, Scalar.add(q,i), i*32);
            if ((i%100000) == 0) console.log(i);
        }
        await f.close();
    });

    it("should fail if trying to override", async () => {
        let throwed = false;
        try {
            await fastFile.createNoOverride(fileName);
        } catch (err) {
            throwed = true;
        }
        assert(throwed == true);
    });

    it("trying to write a readonly File", async () => {
        let throwed = false;
        try {
            const f = await fastFile.readExisting(fileName);
            await writeBigInt(f, Scalar.add(q,3), 0);
            await f.close();
        } catch (err) {
            throwed = true;
        }
        assert(throwed == true);
    });

    it("should read the file", async () => {
        const f = await fastFile.readExisting(fileName);
        for (let i=0; i<1000000; i++) {
            const n = await readBigInt(f, i*32);
            assert(Scalar.sub(n, q) == i);
            if ((i%100000) == 0) console.log("Reading: " + i);
        }
        await f.close();
    });

    it("Should randomly read write", async () => {
        const f = await fastFile.readWriteExisting(fileName);
        for (let i=0; i<10000; i++) {
            const j = Math.floor(Math.random()* 10000);
            // console.log("Start Reading", j);
            const oldVal = await readBigInt(f, j*32);
            let expectedOldVal;
            if (typeof values[j] != "undefined") {
                expectedOldVal = values[j];
            } else {
                expectedOldVal = Scalar.add(q,j);
            }
            assert(Scalar.eq(expectedOldVal, oldVal));
            const newVal = F.random();
            values[j] = newVal;
            // console.log("Start Writing", j);
            await writeBigInt(f, newVal, j*32);
            if ((i%1000) == 0) console.log("Reading: " + i);
        }
        await f.close();
    });

    it("Should continue after closing the file", async () => {
        const f = await fastFile.readWriteExisting(fileName);
        for (let i=0; i<10000; i++) {
            const j = Math.floor(Math.random()* 10000);
            const oldVal = await readBigInt(f, j*32);
            let expectedOldVal;
            if (typeof values[j] != "undefined") {
                expectedOldVal = values[j];
            } else {
                expectedOldVal = Scalar.add(q,j);
            }
            assert(Scalar.eq(expectedOldVal, oldVal));
            const newVal = F.random();
            values[j] = newVal;
            await writeBigInt(f, newVal, j*32);
            if ((i%1000) == 0) console.log("Reading: " + i);
        }
        await f.close();
    });

    it("Should delete the file", async () => {
        await fs.promises.unlink(fileName);
    });


});




