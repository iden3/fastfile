import fs from "fs";
import * as fastFile from "../src/fastfile.js";
import { afterAll, expect } from "vitest";

// The b/c (cacheSize/pageSize) arguments of the entry points historically
// applied only to string/Blob sources; a descriptor object without explicit
// sizes silently got the small built-in defaults. They now act as fallbacks
// for object sources too, filling exactly the fields the caller left
// undefined -- so e.g. snarkjs passing {type: "file"} gets the same tuned
// cache as when it passes a plain path string.
describe("cacheSize/pageSize fallbacks for descriptor objects", function () {
    const fileName = "test_size_fallbacks.bin";

    afterAll(() => {
        if (fs.existsSync(fileName)) fs.unlinkSync(fileName);
    });

    it("object source picks up the fallback sizes it does not set", async () => {
        const fdString = await fastFile.createOverride(fileName, 1 << 22, 1 << 16);
        await fdString.write(new Uint8Array(64), 0);
        await fdString.close();

        const fdObject = await fastFile.readExisting({ type: "file", fileName }, 1 << 22, 1 << 16);
        const fdPlain = await fastFile.readExisting(fileName, 1 << 22, 1 << 16);
        // identical tuning to the string source
        expect(fdObject.pageSize).toBe(fdPlain.pageSize);
        expect(fdObject.maxPagesLoaded).toBe(fdPlain.maxPagesLoaded);
        await fdObject.close();
        await fdPlain.close();
    });

    it("explicit object fields win over the fallbacks", async () => {
        const fd = await fastFile.readExisting(
            { type: "file", fileName, cacheSize: 1 << 20, pageSize: 1 << 13 }, 1 << 25, 1 << 16);
        const fdRef = await fastFile.readExisting(
            { type: "file", fileName, cacheSize: 1 << 20, pageSize: 1 << 13 });
        expect(fd.pageSize).toBe(fdRef.pageSize);
        expect(fd.maxPagesLoaded).toBe(fdRef.maxPagesLoaded);
        await fd.close();
        await fdRef.close();
    });

    it("mem descriptors keep their identity (data written through createNew stays on the caller's object)", async () => {
        // regression: applying the fallbacks via a copy to a {type: "mem"}
        // descriptor detached the memfile store from the caller's object,
        // so a later readExisting(sameObject) found no data
        const memSrc = { type: "mem" };
        const fdW = await fastFile.createOverride(memSrc, 1 << 22, 1 << 16);
        await fdW.write(new Uint8Array([1, 2, 3, 4]), 0);
        await fdW.close();
        expect(memSrc.data).toBeInstanceOf(Uint8Array);
        const fdR = await fastFile.readExisting(memSrc, 1 << 22, 1 << 16);
        const back = await fdR.read(4, 0);
        expect(Array.from(back)).toEqual([1, 2, 3, 4]);
        await fdR.close();
    });

    it("does not mutate the caller's descriptor object", async () => {
        const src = { type: "file", fileName };
        const fd = await fastFile.readExisting(src, 1 << 22, 1 << 16);
        expect(src.cacheSize).toBe(undefined);
        expect(src.pageSize).toBe(undefined);
        await fd.close();
    });
});
