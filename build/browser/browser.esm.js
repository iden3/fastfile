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
var r = /* @__PURE__ */ new Uint8Array(4), i = new DataView(r.buffer), a = /* @__PURE__ */ new Uint8Array(8), o = new DataView(a.buffer), s = class {
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
		let n = this;
		if (t === void 0 && (t = n.pos), this.readOnly) throw Error("Writing a read only file");
		this._resizeIfNeeded(t + e.byteLength), this.o.data.set(e.slice(), t), t + e.byteLength > this.totalSize && (this.totalSize = t + e.byteLength), this.pos = t + e.byteLength;
	}
	async readToBuffer(e, t, n, r) {
		let i = this;
		if (r === void 0 && (r = i.pos), this.readOnly && r + n > this.totalSize) throw Error("Reading out of bounds");
		this._resizeIfNeeded(r + n);
		let a = new Uint8Array(this.o.data.buffer, this.o.data.byteOffset + r, n);
		e.set(a, t), this.pos = r + n;
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
		if (n >= this.totalSize) {
			if (this.readOnly) throw Error("Reading out of bounds");
			return "";
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
var f = /* @__PURE__ */ new Uint8Array(4), p = new DataView(f.buffer), m = /* @__PURE__ */ new Uint8Array(8), h = new DataView(m.buffer), g = class {
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
			let o = Math.min(2048, t.o.data[e].length - a);
			if (o <= 0) return t.pos = n, i;
			let s = new Uint8Array(t.o.data[e].buffer, a, o), l = s.findIndex((e) => e === 0);
			r = l !== -1, r ? (i += new TextDecoder().decode(s.slice(0, l)), t.pos = e * c + a + l + 1) : (i += new TextDecoder().decode(s), t.pos = e * c + a + s.length), n = t.pos;
		}
		return i;
	}
}, _ = 1 << 20, v = 8192, y = class {
	constructor(e, t, n, r) {
		this.readRangeInto = e, this.totalSize = t, this.pos = 0, this.pageSize = r || v, this.maxPagesLoaded = Math.floor((n || _) / this.pageSize) + 1, this.pages = /* @__PURE__ */ new Map(), this.readOnly = !0;
	}
	_pageLen(e) {
		let t = e * this.pageSize;
		return Math.min(t + this.pageSize, this.totalSize) - t;
	}
	_loadPage(e) {
		let t = this, n = t.pages.get(e);
		if (n) return t.pages.delete(e), t.pages.set(e, n), n.promise;
		let r = new Uint8Array(t._pageLen(e));
		return n = {
			buff: null,
			promise: null
		}, n.promise = t.readRangeInto(r, 0, e * t.pageSize, r.byteLength).then(function() {
			return n.buff = r, r;
		}, function(n) {
			throw t.pages.delete(e), n;
		}), t.pages.set(e, n), t._trimCache(), n.promise;
	}
	_trimCache() {
		let e = this;
		if (!(e.pages.size <= e.maxPagesLoaded)) for (let t of e.pages) {
			if (e.pages.size <= e.maxPagesLoaded) return;
			t[1].buff && e.pages.delete(t[0]);
		}
	}
	async readToBuffer(e, t, n, r) {
		let i = this;
		if (n === 0) return;
		if (i.pendingClose) throw Error("Reading a closing file");
		if (r === void 0 && (r = i.pos), r + n > i.totalSize) throw Error("Reading out of bounds");
		if (i.pos = r + n, n >= i.pageSize) {
			await i.readRangeInto(e, t, r, n);
			return;
		}
		let a = Math.floor(r / i.pageSize), o = Math.floor((r + n - 1) / i.pageSize), s = r % i.pageSize, c = 0;
		for (let r = a; r <= o; r++) {
			let a = await i._loadPage(r), o = Math.min(n - c, i.pageSize - s);
			e.set(a.subarray(s, s + o), t + c), c += o, s = 0;
		}
	}
	async read(e, t) {
		let n = new Uint8Array(e);
		return await this.readToBuffer(n, 0, e, t), n;
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
		let t = this;
		if (t.pendingClose) throw Error("Reading a closing file");
		let n = e === void 0 ? t.pos : e, r = [];
		for (; n < t.totalSize;) {
			let e = Math.min(t.pageSize, t.totalSize - n), i = await t.read(e, n), a = i.indexOf(0);
			if (a >= 0) return r.push(i.subarray(0, a)), t.pos = n + a + 1, b(r);
			r.push(i), n += e;
		}
		return t.pos = n, b(r);
	}
	async write() {
		throw Error("Writing a read only file");
	}
	async writeULE32() {
		throw Error("Writing a read only file");
	}
	async writeUBE32() {
		throw Error("Writing a read only file");
	}
	async writeULE64() {
		throw Error("Writing a read only file");
	}
	async close() {
		this.pendingClose || (this.pendingClose = !0, this.pages.clear());
	}
	async discard() {
		await this.close();
	}
};
function b(e) {
	let t = 0;
	for (let n = 0; n < e.length; n++) t += e[n].byteLength;
	let n = new Uint8Array(t), r = 0;
	for (let t = 0; t < e.length; t++) n.set(e[t], r), r += e[t].byteLength;
	return new TextDecoder().decode(n);
}
//#endregion
//#region src/httpfile.js
var x = 65536;
async function S(e) {
	let n = e.url, r = await fetch(n, { headers: { Range: "bytes=0-0" } });
	if (r.status === 206) {
		let t = r.headers.get("content-range"), i = t ? /\/(\d+)\s*$/.exec(t) : null;
		if (i) {
			let t = parseInt(i[1]);
			await r.arrayBuffer();
			let a = w(r), o = null, s = async function(e, t, r, i) {
				if (!o) try {
					return await T(n, a, e, t, r, i);
				} catch (e) {
					if (!e || !e.degradeToFull) throw e;
					o = e.fullBodyPromise;
				}
				let s = await o;
				if (r + i > s.byteLength) throw Error(n + ": read past the end of the buffered body");
				e.set(s.subarray(r, r + i), t);
			}, c = Math.min(e.pageSize || x, x);
			return new y(s, t, e.cacheSize, c);
		}
		return await r.arrayBuffer(), await C(n);
	}
	if (!r.ok && r.status !== 416) throw Error("HTTP " + r.status + " fetching " + n);
	if (r.status === 416) {
		let e = r.headers.get("content-range");
		return e && /\/0\s*$/.test(e) ? t({
			type: "mem",
			data: /* @__PURE__ */ new Uint8Array()
		}) : await C(n);
	}
	return t({
		type: "mem",
		data: new Uint8Array(await r.arrayBuffer())
	});
}
async function C(e) {
	let n = await fetch(e);
	if (!n.ok) throw Error("HTTP " + n.status + " fetching " + e);
	return t({
		type: "mem",
		data: new Uint8Array(await n.arrayBuffer())
	});
}
function w(e) {
	let t = e.headers.get("etag");
	return t && t.indexOf("W/") !== 0 ? t : e.headers.get("last-modified") || null;
}
async function T(e, t, n, r, i, a) {
	let o = { Range: "bytes=" + i + "-" + (i + a - 1) };
	t && (o["If-Range"] = t);
	let s = await fetch(e, { headers: o });
	if (s.status === 200) {
		let n = w(s);
		if (!t || n && n === t) {
			let t = /* @__PURE__ */ Error(e + ": origin ignored Range; degrading to full buffering");
			throw t.degradeToFull = !0, t.fullBodyPromise = s.arrayBuffer().then((e) => new Uint8Array(e)), t;
		}
		throw await E(s), Error(e + ": file changed (or server stopped honoring Range) while reading");
	}
	if (s.status !== 206) throw await E(s), Error("HTTP " + s.status + " reading range " + i + "+" + a + " of " + e);
	let c = s.headers.get("content-range"), l = c ? /bytes\s+(\d+)-(\d+)\//.exec(c) : null;
	if (l && parseInt(l[1]) !== i) throw await E(s), Error(e + ": server returned range starting at " + l[1] + ", requested " + i);
	let u = 0;
	if (s.body && typeof s.body.getReader == "function") {
		let t = s.body.getReader();
		for (;;) {
			let i = await t.read();
			if (i.done) break;
			if (u + i.value.byteLength > a) throw t.cancel().catch(function() {}), Error(e + ": range response longer than requested");
			n.set(i.value, r + u), u += i.value.byteLength;
		}
	} else {
		/* c8 ignore start */
		let t = new Uint8Array(await s.arrayBuffer());
		if (t.byteLength > a) throw Error(e + ": range response longer than requested");
		n.set(t, r), u = t.byteLength;
	}
	if (u !== a) throw Error(e + ": short range response (" + u + "/" + a + " bytes at " + i + ")");
}
async function E(e) {
	try {
		e.body && typeof e.body.cancel == "function" ? await e.body.cancel() : await e.arrayBuffer();
	} catch {}
}
//#endregion
//#region src/blobfile.js
var D = 1 << 20;
function O(e) {
	let t = e.blob, n = async function(e, n, r, i) {
		let a = await t.slice(r, r + i).arrayBuffer();
		if (a.byteLength !== i) throw Error("short blob read (" + a.byteLength + "/" + i + " bytes at " + r + ")");
		e.set(new Uint8Array(a), n);
	}, r = Math.min(e.pageSize || D, D);
	return new y(n, t.size, e.cacheSize, r);
}
//#endregion
//#region src/fastfile.browser.js
function k() {
	throw Error("File I/O is not supported in the browser");
}
function A(e) {
	return e instanceof Uint8Array ? {
		type: "mem",
		data: e
	} : (typeof e == "string" && k(), e);
}
function j(e, t, n) {
	if (e.type === "file" && k(), e.type === "mem") return t(e);
	if (e.type === "bigMem") return n(e);
	throw Error("Invalid FastFile type: " + e.type);
}
function M(t) {
	return j(A(t), e, l);
}
var N = M;
async function P(e, n, r) {
	return e instanceof Uint8Array && (e = {
		type: "mem",
		data: e
	}), typeof Blob < "u" && e instanceof Blob && (e = {
		type: "blob",
		blob: e,
		cacheSize: n,
		pageSize: r
	}), typeof e == "string" && (e = {
		type: "http",
		url: e,
		cacheSize: n,
		pageSize: r
	}), e.type === "http" ? await S(e) : e.type === "blob" ? O(e) : j(e, t, u);
}
function F(e) {
	return typeof e == "string" && k(), j(e, n, d);
}
var I = F;
//#endregion
export { N as createNoOverride, M as createOverride, P as readExisting, F as readWriteExisting, I as readWriteExistingOrCreate };
