import fs from "fs";
import * as testUtils from "./testUtils.js";
import * as fastFile from "../src/fastfile.js";
import { expect } from "vitest";

describe("fastfile testing suite for osfile", function () {
    let fileName = "test_osfile.bin";
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
        expect(str).toBe(str1);

        str = await fd.readString();
        expect(str).toBe(str2);

        str = await fd.readString();
        expect(str).toBe(str3);

        await fd.close();

        await fs.promises.unlink(fileName);
    });

    it("should throw error when try to read a closed file", async () => {
        const fd = await fastFile.createOverride(fileName);
        await fd.close();
        await expect(fd.readString(0)).rejects.toThrow("Reading a closing file");
        await fs.promises.unlink(fileName);
    });
});




