import * as fastFile from "../src/fastfile.browser.js";
import * as testUtils from "./testUtils.js";
import { vi, expect } from "vitest";

describe("fastfile browser — mem", function () {
    const str1 = "0123456789";
    const str2 = "Hi_there";
    const str3 = "/!!--::**";

    it("should read valid strings from mem file", async () => {
        const fd = await fastFile.createOverride({ type: "mem" });

        await testUtils.writeFakeStringToFile(fd, 10);
        await testUtils.writeStringToFile(fd, str1);
        await testUtils.writeStringToFile(fd, str2);
        await testUtils.writeStringToFile(fd, str3);

        let str = await fd.readString(10);
        expect(str).toBe(str1);

        str = await fd.readString();
        expect(str).toBe(str2);

        str = await fd.readString();
        expect(str).toBe(str3);

        await fd.close();
    });

    it("createNoOverride is an alias for createOverride in browser", async () => {
        const fd = await fastFile.createNoOverride({ type: "mem" });
        expect(fd).toBeTruthy();
        await fd.close();
    });

    it("readExisting from Uint8Array", async () => {
        const data = new Uint8Array([10, 20, 30]);
        const fd = await fastFile.readExisting(data);
        const result = await fd.read(3, 0);
        expect([...result]).toEqual([10, 20, 30]);
        await fd.close();
    });

    it("readExisting from URL fetches data", async () => {
        const mockData = new Uint8Array([1, 2, 3]);
        vi.stubGlobal("fetch", () =>
            Promise.resolve({ arrayBuffer: () => Promise.resolve(mockData.buffer.slice(0)) })
        );
        try {
            const fd = await fastFile.readExisting("https://example.com/test.bin");
            const result = await fd.read(3, 0);
            expect([...result]).toEqual([1, 2, 3]);
            await fd.close();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("throws when using file type", () => {
        expect(() => fastFile.createOverride({ type: "file", fileName: "test" }))
            .toThrow("not supported in the browser");
    });

    it("readWriteExistingOrCreate is an alias for readWriteExisting", async () => {
        const o = { type: "mem", data: new Uint8Array([5, 6, 7]) };
        const fd = await fastFile.readWriteExistingOrCreate(o);
        expect(fd).toBeTruthy();
        await fd.close();
    });
});

describe("fastfile browser — bigMem", function () {
    const str1 = "0123456789";
    const str2 = "Hi_there";
    const str3 = "/!!--::**";

    it("should read valid strings from bigMem file", async () => {
        const fd = await fastFile.createOverride({ type: "bigMem" });

        await testUtils.writeFakeStringToFile(fd, 10);
        await testUtils.writeStringToFile(fd, str1);
        await testUtils.writeStringToFile(fd, str2);
        await testUtils.writeStringToFile(fd, str3);

        let str = await fd.readString(10);
        expect(str).toBe(str1);

        str = await fd.readString();
        expect(str).toBe(str2);

        str = await fd.readString();
        expect(str).toBe(str3);

        await fd.close();
    });

    it("throws for file type on bigMem project", () => {
        expect(() => fastFile.readWriteExisting({ type: "file" }))
            .toThrow("not supported in the browser");
    });
});
