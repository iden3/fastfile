import * as testUtils from "./testUtils.js";
import * as fastFile from "../src/fastfile.js";
import { expect } from "vitest";

describe("fastfile testing suite for memfile", function () {
    let str1 = "0123456789";
    let str2 = "Hi_there";
    let str3 = "/!!--::**";

    it("should read valid strings from mem file", async () => {
        const file = {
            type: "mem"
        };

        let fd = await fastFile.createOverride(file);

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

    it("should throws an error when trying to access out of bounds on a mem read only file", async () => {
        const file = {
            type: "mem",
            data: {
                byteLength: 1
            }
        };
        const fd = await fastFile.readExisting(file);
        await expect(fd.readString(10)).rejects.toThrow("Reading out of bounds");
    });
});




