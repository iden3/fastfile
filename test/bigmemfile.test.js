import * as testUtils from "./testUtils.js";
import * as fastFile from "../src/fastfile.js";

import assert from "assert";
import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";

chai.use(chaiAsPromised);
const expect = chai.expect;

describe("fastfile testing suite for bigMemFile", function () {
    this.timeout(100000);

    let str1 = "0123456789";
    let str2 = "Hi_there";
    let str3 = "/!!--::**";

    it("should read valid strings from bigmem file", async () => {
        const file = {
            type: "bigMem"
        };

        let fd = await fastFile.createOverride(file);

        await testUtils.writeFakeStringToFile(fd, (1 << 22) - 9);

        await testUtils.writeStringToFile(fd, str1);
        await testUtils.writeStringToFile(fd, str2);
        await testUtils.writeStringToFile(fd, str3);

        let str = await fd.readString((1 << 22) - 9);
        assert.strictEqual(str, str1);

        str = await fd.readString();
        assert.strictEqual(str, str2);

        str = await fd.readString();
        assert.strictEqual(str, str3);

        await fd.close();
    });

    it("should throws an error when trying to access out of bounds on a bigmem read only file", async () => {
        const file = {
            type: "bigMem",
            data: [{
                byteLength: 1
            }]
        };
        let fd = await fastFile.readExisting(file);
        expect(fd.readString(10)).to.be.rejectedWith("Reading out of bounds");
    });

});




