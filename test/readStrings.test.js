import assert from "assert";

import fs from "fs";

import * as fastFile from "../src/fastfile.js";

async function writeStringToFile(fd, str) {
    let buff = new Uint8Array(str.length + 1);
    for (let i = 0; i < str.length; i++) {
        buff[i] = str.charCodeAt(i);
    }
    buff[str.length] = 0;

    fd.write(buff);
}

describe("fastfile testing suite: readStrings test", function () {
    let fileName = "test_2.bin";

    this.timeout(100000);

    let str1 = "0123456789";
    let str2 = "Hi_there";
    let str3 = "/!!--::**";

    it("should write test files for testing read&write string methods", async () => {
        let fd = await fastFile.createOverride(fileName);

        let fakeDataLength = fd.pageSize - 11;
        let buff = new Uint8Array(fakeDataLength);
        for (let i = 0; i < fakeDataLength; i++) {
            buff[i] = 1;
        }
        await fd.write(buff);

        await writeStringToFile(fd, str1);
        await writeStringToFile(fd, str2);
        await writeStringToFile(fd, str3);

        await fd.close();

        assert(fs.existsSync(fileName));
    });


    it("should read valid strings from file", async () => {
        let fd = await fastFile.readExisting(fileName);

        let str = await fd.readString(fd.pageSize - 11);
        assert.strictEqual(str, str1);

        str = await fd.readString();
        assert.strictEqual(str, str2);

        str = await fd.readString();
        assert.strictEqual(str, str3);

        await fd.close();
        await fs.promises.unlink(fileName);
    });

    // it("should throw error when try to read a closed file", async () => {
    //     let fd = await fastFile.readExisting(fileName);
    //     await fd.close();
    //     chai.expect(await fd.readString(0),new Error("Reading a closing file"));
    // });

    it("should read valid strings from mem file", async () => {
        const file = {
            type: "mem"
        };

        let fd = await fastFile.createOverride(file);

        let fakeDataLength = 10;
        let buff = new Uint8Array(fakeDataLength);
        for (let i = 0; i < fakeDataLength; i++) {
            buff[i] = 1;
        }
        await fd.write(buff);

        await writeStringToFile(fd, str1);
        await writeStringToFile(fd, str2);
        await writeStringToFile(fd, str3);

        let str = await fd.readString(10);
        assert.strictEqual(str, str1);

        str = await fd.readString();
        assert.strictEqual(str, str2);

        str = await fd.readString();
        assert.strictEqual(str, str3);

        await fd.close();
    });

    it("should read valid strings from bigmem file", async () => {
        const file = {
            type: "bigMem"
        };

        let fd = await fastFile.createOverride(file);

        let fakeDataLength = (1 << 22) - 9;
        let buff = new Uint8Array(fakeDataLength);
        for (let i = 0; i < fakeDataLength; i++) {
            buff[i] = 1;
        }
        await fd.write(buff);

        await writeStringToFile(fd, str1);
        await writeStringToFile(fd, str2);
        await writeStringToFile(fd, str3);

        let str = await fd.readString((1 << 22) - 9);
        assert.strictEqual(str, str1);

        str = await fd.readString();
        assert.strictEqual(str, str2);

        str = await fd.readString();
        assert.strictEqual(str, str3);

        await fd.close();
    });
});




