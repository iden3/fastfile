import { expect } from "vitest";
import fs from "fs";

import * as fastFile from "../src/fastfile.js";

import { Scalar, F1Field } from "ffjavascript";

const q = Scalar.fromString("21888242871839275222246405745257275088548364400416034343698204186575808495617");
const F = new F1Field(q);

async function writeBigInt(f, n, pos) {
    const n8 = 32;
    const buff = new Uint8Array(n8);
    Scalar.toRprLE(buff, 0, n, n8);

    await f.write(buff, pos);
}

async function readBigInt(f, pos) {
    const n8 = 32;

    const buff = await f.read(n8, pos);
    expect(buff.byteLength).toBe(n8);

    return Scalar.fromRprLE(buff, 0);
}

describe("fastfile test", function () {
    let fileName = "test.bin";
    const values = {};

    it("should write a big file sequentially", async () => {
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
        await expect(fastFile.createNoOverride(fileName)).rejects.toThrow();
    });

    it("trying to write a readonly File", async () => {
        await expect(async () => {
            const f = await fastFile.readExisting(fileName);
            await writeBigInt(f, Scalar.add(q,3), 0);
            await f.close();
        }).rejects.toThrow();
    });

    it("should read the file", async () => {
        const f = await fastFile.readExisting(fileName);
        for (let i=0; i<1000000; i++) {
            const n = await readBigInt(f, i*32);
            if (Scalar.sub(n, q) != i) {
                console.log(f);
                console.log(Scalar.sub(n, q));
                console.log(i);
            }
            expect(Scalar.sub(n, q) == i).toBe(true);
            if ((i%100000) == 0) console.log("Reading: " + i);
        }
        await f.close();
    });

    it("Should randomly read write", async () => {
        const f = await fastFile.readWriteExisting(fileName);
        for (let i=0; i<100000; i++) {
            const j = Math.floor(Math.random()* 100000);
            // console.log("Start Reading", j);
            const oldVal = await readBigInt(f, j*32);
            let expectedOldVal;
            if (typeof values[j] != "undefined") {
                expectedOldVal = values[j];
            } else {
                expectedOldVal = Scalar.add(q,j);
            }
            expect(Scalar.eq(expectedOldVal, oldVal)).toBe(true);
            const newVal = F.random();
            values[j] = newVal;
            // console.log("Start Writing", j);
            await writeBigInt(f, newVal, j*32);
            if ((i%1000) == 0) console.log("Reading random R/W: " + i);
        }
        await f.close();
    });

    it("Should randomly multi read", async () => {
        const f = await fastFile.readExisting(fileName);

        const ops = [];
        const expectedOldVal = [];
        for (let i=0; i<100000; i++) {
            const j = Math.floor(Math.random()* 100000);
            // console.log("Start Reading", j);
            ops.push(readBigInt(f, j*32));

            if (typeof values[j] != "undefined") {
                expectedOldVal[i] = values[j];
            } else {
                expectedOldVal[i] = Scalar.add(q,j);
            }
            if ((i%1000) == 0) console.log("Reading Multi: " + i);
        }

        const vals = await Promise.all(ops);

        for (let i=0; i<vals.length; i++) {
            expect(Scalar.eq(expectedOldVal[i], vals[i])).toBe(true);
            if ((i%1000) == 0) console.log("Checking Multi: " + i);
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
            expect(Scalar.eq(expectedOldVal, oldVal)).toBe(true);
            const newVal = F.random();
            values[j] = newVal;
            await writeBigInt(f, newVal, j*32);
            if ((i%1000) == 0) console.log("Reading after closing: " + i);
        }
        await f.close();
    });

    it("Should delete the file", async () => {
        await fs.promises.unlink(fileName);
    });


});




