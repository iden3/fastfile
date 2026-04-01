//#region src/memfile.js
function e(e) {
	let t = e.initialSize || 1 << 20, n = new s();
	return n.o = e, n.o.data = new Uint8Array(t), n.allocSize = t, n.totalSize = 0, n.readOnly = !1, n.pos = 0, n;
}
function t(e) {
	let t = new s();
	return t.o = e, t.allocSize = e.data.byteLength, t.totalSize = e.data.byteLength, t.readOnly = !0, t.pos = 0, t;
}
function n(e) {
	let t = new s();
	return t.o = e, t.allocSize = e.data.byteLength, t.totalSize = e.data.byteLength, t.readOnly = !1, t.pos = 0, t;
}
var r = new Uint8Array(4), i = new DataView(r.buffer), a = new Uint8Array(8), o = new DataView(a.buffer), s = class {
	constructor() {
		this.pageSize = 16384;
	}
	_resizeIfNeeded(e) {
		if (e > this.allocSize) {
			let t = Math.max(this.allocSize + (1 << 20), Math.floor(this.allocSize * 1.1), e), n = new Uint8Array(t);
			n.set(this.o.data), this.o.data = n, this.allocSize = t;
		}
	}
	async write(e, t) {
		if (t === void 0 && (t = this.pos), this.readOnly) throw Error("Writing a read only file");
		this._resizeIfNeeded(t + e.byteLength), this.o.data.set(e.slice(), t), t + e.byteLength > this.totalSize && (this.totalSize = t + e.byteLength), this.pos = t + e.byteLength;
	}
	async readToBuffer(e, t, n, r) {
		if (r === void 0 && (r = this.pos), this.readOnly && r + n > this.totalSize) throw Error("Reading out of bounds");
		this._resizeIfNeeded(r + n);
		let i = new Uint8Array(this.o.data.buffer, this.o.data.byteOffset + r, n);
		e.set(i, t), this.pos = r + n;
	}
	async read(e, t) {
		let n = this, r = new Uint8Array(e);
		return await n.readToBuffer(r, 0, e, t), r;
	}
	close() {
		this.o.data.byteLength != this.totalSize && (this.o.data = this.o.data.slice(0, this.totalSize));
	}
	async discard() {}
	async writeULE32(e, t) {
		let n = this;
		i.setUint32(0, e, !0), await n.write(r, t);
	}
	async writeUBE32(e, t) {
		let n = this;
		i.setUint32(0, e, !1), await n.write(r, t);
	}
	async writeULE64(e, t) {
		let n = this;
		o.setUint32(0, e & 4294967295, !0), o.setUint32(4, Math.floor(e / 4294967296), !0), await n.write(a, t);
	}
	async readULE32(e) {
		let t = await this.read(4, e);
		return new Uint32Array(t.buffer)[0];
	}
	async readUBE32(e) {
		let t = await this.read(4, e);
		return new DataView(t.buffer).getUint32(0, !1);
	}
	async readULE64(e) {
		let t = await this.read(8, e), n = new Uint32Array(t.buffer);
		return n[1] * 4294967296 + n[0];
	}
	async readString(e) {
		let t = this, n = e === void 0 ? t.pos : e;
		if (n > this.totalSize) {
			if (this.readOnly) throw Error("Reading out of bounds");
			this._resizeIfNeeded(e);
		}
		let r = new Uint8Array(t.o.data.buffer, n, this.totalSize - n), i = r.findIndex((e) => e === 0), a = i !== -1, o = "";
		return a ? (o = new TextDecoder().decode(r.slice(0, i)), t.pos = n + i + 1) : t.pos = n, o;
	}
}, c = 1 << 22;
function l(e) {
	let t = e.initialSize || 0, n = new g();
	n.o = e;
	let r = t ? Math.floor((t - 1) / c) + 1 : 0;
	n.o.data = [];
	for (let e = 0; e < r - 1; e++) n.o.data.push(new Uint8Array(c));
	return r && n.o.data.push(new Uint8Array(t - c * (r - 1))), n.totalSize = 0, n.readOnly = !1, n.pos = 0, n;
}
function u(e) {
	let t = new g();
	return t.o = e, t.totalSize = (e.data.length - 1) * c + e.data[e.data.length - 1].byteLength, t.readOnly = !0, t.pos = 0, t;
}
function d(e) {
	let t = new g();
	return t.o = e, t.totalSize = (e.data.length - 1) * c + e.data[e.data.length - 1].byteLength, t.readOnly = !1, t.pos = 0, t;
}
var f = new Uint8Array(4), p = new DataView(f.buffer), m = new Uint8Array(8), h = new DataView(m.buffer), g = class {
	constructor() {
		this.pageSize = 16384;
	}
	_resizeIfNeeded(e) {
		if (e <= this.totalSize) return;
		if (this.readOnly) throw Error("Reading out of file bounds");
		let t = Math.floor((e - 1) / c) + 1;
		for (let n = Math.max(this.o.data.length - 1, 0); n < t; n++) {
			let r = n < t - 1 ? c : e - (t - 1) * c, i = new Uint8Array(r);
			n == this.o.data.length - 1 && i.set(this.o.data[n]), this.o.data[n] = i;
		}
		this.totalSize = e;
	}
	async write(e, t) {
		let n = this;
		if (t === void 0 && (t = n.pos), this.readOnly) throw Error("Writing a read only file");
		this._resizeIfNeeded(t + e.byteLength);
		let r = Math.floor(t / c), i = t % c, a = e.byteLength;
		for (; a > 0;) {
			let t = i + a > c ? c - i : a, o = e.slice(e.byteLength - a, e.byteLength - a + t);
			new Uint8Array(n.o.data[r].buffer, i, t).set(o), a -= t, r++, i = 0;
		}
		this.pos = t + e.byteLength;
	}
	async readToBuffer(e, t, n, r) {
		let i = this;
		if (r === void 0 && (r = i.pos), this.readOnly && r + n > this.totalSize) throw Error("Reading out of bounds");
		this._resizeIfNeeded(r + n);
		let a = Math.floor(r / c), o = r % c, s = n;
		for (; s > 0;) {
			let r = o + s > c ? c - o : s, l = new Uint8Array(i.o.data[a].buffer, o, r);
			e.set(l, t + n - s), s -= r, a++, o = 0;
		}
		this.pos = r + n;
	}
	async read(e, t) {
		let n = this, r = new Uint8Array(e);
		return await n.readToBuffer(r, 0, e, t), r;
	}
	close() {}
	async discard() {}
	async writeULE32(e, t) {
		let n = this;
		p.setUint32(0, e, !0), await n.write(f, t);
	}
	async writeUBE32(e, t) {
		let n = this;
		p.setUint32(0, e, !1), await n.write(f, t);
	}
	async writeULE64(e, t) {
		let n = this;
		h.setUint32(0, e & 4294967295, !0), h.setUint32(4, Math.floor(e / 4294967296), !0), await n.write(m, t);
	}
	async readULE32(e) {
		let t = await this.read(4, e);
		return new Uint32Array(t.buffer)[0];
	}
	async readUBE32(e) {
		let t = await this.read(4, e);
		return new DataView(t.buffer).getUint32(0, !1);
	}
	async readULE64(e) {
		let t = await this.read(8, e), n = new Uint32Array(t.buffer);
		return n[1] * 4294967296 + n[0];
	}
	async readString(e) {
		let t = this, n = e === void 0 ? t.pos : e;
		if (n > this.totalSize) {
			if (this.readOnly) throw Error("Reading out of bounds");
			this._resizeIfNeeded(e);
		}
		let r = !1, i = "";
		for (; !r;) {
			let e = Math.floor(n / c), a = n % c;
			if (t.o.data[e] === void 0) throw Error("ERROR");
			let o = Math.min(2048, t.o.data[e].length - a), s = new Uint8Array(t.o.data[e].buffer, a, o), l = s.findIndex((e) => e === 0);
			r = l !== -1, r ? (i += new TextDecoder().decode(s.slice(0, l)), t.pos = e * c + a + l + 1) : (i += new TextDecoder().decode(s), t.pos = e * c + a + s.length), n = t.pos;
		}
		return i;
	}
}, _ = 65536;
function v() {
	throw Error("File I/O is not supported in the browser");
}
function y(e, t) {
	return e instanceof Uint8Array ? {
		type: "mem",
		data: e
	} : typeof e == "string" ? {
		type: "mem",
		initialSize: t || _
	} : e;
}
async function b(e) {
	let t = await fetch(e).then((e) => e.arrayBuffer());
	return {
		type: "mem",
		data: new Uint8Array(t)
	};
}
function x(e, t, n) {
	if (e.type === "file" && v(), e.type === "mem") return t(e);
	if (e.type === "bigMem") return n(e);
	throw Error("Invalid FastFile type: " + e.type);
}
function S(t, n) {
	return x(y(t, n), e, l);
}
var C = S;
async function w(e) {
	return e = typeof e == "string" ? await b(e) : y(e), x(e, t, u);
}
function T(e) {
	return typeof e == "string" && v(), x(e, n, d);
}
var E = T;
//#endregion
export { C as createNoOverride, S as createOverride, w as readExisting, T as readWriteExisting, E as readWriteExistingOrCreate };
