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
//#region src/idbcache.js
var x = 1 << 21, S = 1 << 29, C = "fastfile-http-cache", w = /* @__PURE__ */ new Map();
function T(e) {
	if (w.has(e)) return w.get(e);
	let t = new Promise((t, n) => {
		let r = indexedDB.open(e, 1);
		r.onupgradeneeded = () => {
			let e = r.result;
			e.createObjectStore("files"), e.createObjectStore("blocks");
		}, r.onsuccess = () => t(r.result), r.onerror = () => n(r.error), r.onblocked = () => n(/* @__PURE__ */ Error("IndexedDB open blocked"));
	});
	return w.set(e, t), t.catch(() => w.delete(e)), t;
}
function E(e) {
	return new Promise((t, n) => {
		e.onsuccess = () => t(e.result), e.onerror = () => n(e.error);
	});
}
function D(e) {
	return new Promise((t, n) => {
		e.oncomplete = () => t(), e.onerror = () => n(e.error), e.onabort = () => n(e.error || /* @__PURE__ */ Error("IndexedDB transaction aborted"));
	});
}
function O(e, t, n) {
	return IDBKeyRange.bound([e, t], [e, n]);
}
async function k(e, t) {
	let n = e.transaction(["files", "blocks"], "readwrite");
	n.objectStore("files").delete(t), n.objectStore("blocks").delete(O(t, 0, Infinity)), await D(n);
}
async function A(e, t, n, r, i, a) {
	let o = e.transaction(["files", "blocks"], "readwrite"), s = o.objectStore("files"), c = await E(s.get(t)), l = 0;
	c && c.validator === n && c.totalSize === r && c.blockSize === i ? l = c.bytes : c && o.objectStore("blocks").delete(O(t, 0, Infinity)), s.put({
		validator: n,
		totalSize: r,
		blockSize: i,
		bytes: l,
		lastUsed: Date.now()
	}, t), await D(o);
	let u = e.transaction("files", "readonly"), d = u.objectStore("files"), [f, p] = await Promise.all([E(d.getAllKeys()), E(d.getAll())]);
	await D(u);
	let m = p.reduce((e, t) => e + t.bytes, 0);
	if (m <= a) return;
	let h = f.map((e, t) => ({
		key: e,
		meta: p[t]
	})).filter((e) => e.key !== t).sort((e, t) => e.meta.lastUsed - t.meta.lastUsed);
	for (let t of h) {
		if (m <= a) break;
		await k(e, t.key), m -= t.meta.bytes;
	}
}
async function j(e, t) {
	let { fileKey: n, validator: r, totalSize: i } = t, a = typeof t.options == "object" && t.options || {}, o = a.blockSize || x, s = a.maxBytes || S, c = a.dbName || C;
	if (typeof indexedDB > "u" || !r) return e;
	let l;
	try {
		l = await T(c), await A(l, n, r, i, o, s);
	} catch {
		return e;
	}
	let u = !1;
	async function d(e, t) {
		let r = l.transaction("blocks", "readonly"), i = r.objectStore("blocks"), a = O(n, e, t), [o, s] = await Promise.all([E(i.getAllKeys(a)), E(i.getAll(a))]);
		await D(r);
		let c = /* @__PURE__ */ new Map();
		for (let e = 0; e < o.length; e++) c.set(o[e][1], s[e]);
		return c;
	}
	async function f(e) {
		if (!(u || e.length === 0)) try {
			let t = l.transaction(["files", "blocks"], "readwrite"), r = t.objectStore("blocks"), i = t.objectStore("files");
			for (let t of e) r.put(t.data, [n, t.index]);
			let a = await E(i.get(n));
			a && (a.bytes += e.reduce((e, t) => e + t.data.byteLength, 0), a.lastUsed = Date.now(), i.put(a, n)), await D(t);
		} catch {
			u = !0;
		}
	}
	let p = (e) => Math.min(o, i - e * o), m = /* @__PURE__ */ new Map();
	function h(e) {
		let t, n, r = new Promise((e, r) => {
			t = e, n = r;
		});
		return r.catch(() => {}), m.set(e, r), {
			resolve: t,
			reject: n,
			promise: r
		};
	}
	return async function(t, n, r, i) {
		if (i === 0) return;
		let a = Math.floor(r / o), s = Math.floor((r + i - 1) / o), c = await d(a, s), l = [], u = (e, a) => {
			let s = a * o, c = Math.max(r, s), l = Math.min(r + i, s + p(a));
			t.set(e.subarray(c - s, l - s), n + (c - r));
		}, g = a;
		for (; g <= s;) {
			let a = g * o, d = a + p(g), f = c.get(g);
			if (f) {
				u(f, g), g++;
				continue;
			}
			let _ = m.get(g);
			if (_) {
				u(await _, g), g++;
				continue;
			}
			if (a >= r && d <= r + i) {
				let u = g;
				for (; u + 1 <= s && !c.get(u + 1) && !m.get(u + 1) && (u + 1) * o + p(u + 1) <= r + i;) u++;
				let d = a, f = u * o + p(u), _ = [];
				for (let e = g; e <= u; e++) _.push(h(e));
				try {
					await e(t, n + (d - r), d, f - d);
				} catch (e) {
					for (let t = g; t <= u; t++) _[t - g].reject(e), m.delete(t);
					throw e;
				}
				for (let e = g; e <= u; e++) {
					let i = e * o, a = t.slice(n + (i - r), n + (i - r) + p(e));
					_[e - g].resolve(a), l.push({
						index: e,
						data: a
					});
				}
				g = u + 1;
			} else {
				let t = h(g), n = new Uint8Array(p(g));
				try {
					await e(n, 0, a, n.length);
				} catch (e) {
					throw t.reject(e), m.delete(g), e;
				}
				t.resolve(n), u(n, g), l.push({
					index: g,
					data: n
				}), g++;
			}
		}
		await f(l);
		for (let e of l) m.delete(e.index);
	};
}
//#endregion
//#region src/httpfile.js
var M = 65536;
async function N(e) {
	let n = e.url, r = await fetch(n, { headers: { Range: "bytes=0-0" } });
	if (r.status === 206) {
		let t = r.headers.get("content-range"), i = t ? /\/(\d+)\s*$/.exec(t) : null;
		if (i) {
			let t = parseInt(i[1]);
			await r.arrayBuffer();
			let a = F(r), o = null, s = async function(e, t, r, i) {
				if (!o) try {
					return await I(n, a, e, t, r, i);
				} catch (e) {
					if (!e || !e.degradeToFull) throw e;
					o = e.fullBodyPromise;
				}
				let s = await o;
				if (r + i > s.byteLength) throw Error(n + ": read past the end of the buffered body");
				e.set(s.subarray(r, r + i), t);
			}, c = Math.min(e.pageSize || M, M);
			return e.persistentCache && (s = await j(s, {
				fileKey: n,
				validator: a,
				totalSize: t,
				options: e.persistentCache
			})), new y(s, t, e.cacheSize, c);
		}
		return await r.arrayBuffer(), await P(n);
	}
	if (!r.ok && r.status !== 416) throw Error("HTTP " + r.status + " fetching " + n);
	if (r.status === 416) {
		let e = r.headers.get("content-range");
		return e && /\/0\s*$/.test(e) ? t({
			type: "mem",
			data: /* @__PURE__ */ new Uint8Array()
		}) : await P(n);
	}
	return t({
		type: "mem",
		data: new Uint8Array(await r.arrayBuffer())
	});
}
async function P(e) {
	let n = await fetch(e);
	if (!n.ok) throw Error("HTTP " + n.status + " fetching " + e);
	return t({
		type: "mem",
		data: new Uint8Array(await n.arrayBuffer())
	});
}
function F(e) {
	let t = e.headers.get("etag");
	return t && t.indexOf("W/") !== 0 ? t : e.headers.get("last-modified") || null;
}
async function I(e, t, n, r, i, a) {
	let o = { Range: "bytes=" + i + "-" + (i + a - 1) };
	t && (o["If-Range"] = t);
	let s = await fetch(e, { headers: o });
	if (s.status === 200) {
		let n = F(s);
		if (!t || n && n === t) {
			let t = /* @__PURE__ */ Error(e + ": origin ignored Range; degrading to full buffering");
			throw t.degradeToFull = !0, t.fullBodyPromise = s.arrayBuffer().then((e) => new Uint8Array(e)), t;
		}
		throw await L(s), Error(e + ": file changed (or server stopped honoring Range) while reading");
	}
	if (s.status !== 206) throw await L(s), Error("HTTP " + s.status + " reading range " + i + "+" + a + " of " + e);
	let c = s.headers.get("content-range"), l = c ? /bytes\s+(\d+)-(\d+)\//.exec(c) : null;
	if (l && parseInt(l[1]) !== i) throw await L(s), Error(e + ": server returned range starting at " + l[1] + ", requested " + i);
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
async function L(e) {
	try {
		e.body && typeof e.body.cancel == "function" ? await e.body.cancel() : await e.arrayBuffer();
	} catch {}
}
//#endregion
//#region src/blobfile.js
var R = 1 << 20;
function z(e) {
	let t = e.blob, n = async function(e, n, r, i) {
		let a = await t.slice(r, r + i).arrayBuffer();
		if (a.byteLength !== i) throw Error("short blob read (" + a.byteLength + "/" + i + " bytes at " + r + ")");
		e.set(new Uint8Array(a), n);
	}, r = Math.min(e.pageSize || R, R);
	return new y(n, t.size, e.cacheSize, r);
}
//#endregion
//#region src/fastfile.browser.js
function B() {
	throw Error("File I/O is not supported in the browser");
}
function V(e) {
	return e instanceof Uint8Array ? {
		type: "mem",
		data: e
	} : (typeof e == "string" && B(), e);
}
function H(e, t, n) {
	if (e.type === "file" && B(), e.type === "mem") return t(e);
	if (e.type === "bigMem") return n(e);
	throw Error("Invalid FastFile type: " + e.type);
}
function U(t) {
	return H(V(t), e, l);
}
var W = U;
async function G(e, n, r) {
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
	}), e.type === "http" ? await N(e) : e.type === "blob" ? z(e) : H(e, t, u);
}
function K(e) {
	return typeof e == "string" && B(), H(e, n, d);
}
var q = K;
//#endregion
export { W as createNoOverride, U as createOverride, G as readExisting, K as readWriteExisting, q as readWriteExistingOrCreate };
