// In-memory document store (tests, offline dev). Optional JSON-file persistence via MEMORY_FILE.
// Implements the same small DocumentStore contract as the Mongo adapter (see ../store.md in README).
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { matches, applyUpdate, sortDocs, clone } from './query.js';

class MemoryCollection {
  constructor(store, name) {
    this.store = store;
    this.name = name;
    this.docs = new Map();
    this.uniques = [];
  }
  _checkUnique(doc, ignoreId) {
    for (const field of this.uniques) {
      const v = doc[field];
      if (v === undefined) continue;
      for (const d of this.docs.values()) {
        if (d._id !== ignoreId && d[field] === v) {
          const err = new Error(`duplicate key ${this.name}.${field}`);
          err.code = 11000;
          throw err;
        }
      }
    }
  }
  async ensureIndex(fields, opts = {}) {
    if (opts.unique) this.uniques.push(Object.keys(fields)[0]);
  }
  async insertOne(doc) {
    if (doc._id === undefined) throw new Error('documents need an _id');
    if (this.docs.has(doc._id)) {
      const err = new Error('duplicate _id');
      err.code = 11000;
      throw err;
    }
    this._checkUnique(doc);
    this.docs.set(doc._id, clone(doc));
    this.store.dirty();
    return doc;
  }
  async insertMany(docs) {
    for (const d of docs) await this.insertOne(d);
  }
  async findOne(filter = {}) {
    for (const d of this.docs.values()) if (matches(d, filter)) return clone(d);
    return null;
  }
  async find(filter = {}, opts = {}) {
    let out = [...this.docs.values()].filter((d) => matches(d, filter));
    if (opts.sort) out = sortDocs(out, opts.sort);
    if (opts.skip) out = out.slice(opts.skip);
    if (opts.limit) out = out.slice(0, opts.limit);
    return out.map(clone);
  }
  async count(filter = {}) {
    let n = 0;
    for (const d of this.docs.values()) if (matches(d, filter)) n++;
    return n;
  }
  async updateOne(filter, update, opts = {}) {
    for (const d of this.docs.values()) {
      if (!matches(d, filter)) continue;
      const next = applyUpdate(clone(d), update, false);
      this._checkUnique(next, d._id);
      this.docs.set(d._id, next);
      this.store.dirty();
      return { matched: 1 };
    }
    if (opts.upsert) {
      const base = {};
      for (const [k, v] of Object.entries(filter)) if (typeof v !== 'object' || v === null) base[k] = v;
      const doc = applyUpdate(base, update, true);
      if (doc._id === undefined) throw new Error('upsert needs _id in filter or $set');
      await this.insertOne(doc);
      return { matched: 0, upserted: 1 };
    }
    return { matched: 0 };
  }
  async updateMany(filter, update) {
    let n = 0;
    for (const d of this.docs.values()) {
      if (!matches(d, filter)) continue;
      this.docs.set(d._id, applyUpdate(clone(d), update, false));
      n++;
    }
    if (n) this.store.dirty();
    return { matched: n };
  }
  async bulkUpdate(ops) {
    for (const op of ops) await this.updateOne(op.filter, op.update, op.opts);
  }
  async deleteOne(filter) {
    for (const d of this.docs.values()) {
      if (matches(d, filter)) {
        this.docs.delete(d._id);
        this.store.dirty();
        return 1;
      }
    }
    return 0;
  }
  async deleteMany(filter = {}) {
    let n = 0;
    for (const d of [...this.docs.values()]) {
      if (matches(d, filter)) {
        this.docs.delete(d._id);
        n++;
      }
    }
    if (n) this.store.dirty();
    return n;
  }
}

export class MemoryStore {
  constructor({ file } = {}) {
    this.file = file;
    this.collections = new Map();
    this.timer = null;
    if (file && existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      for (const [name, docs] of Object.entries(data)) {
        const c = this.collection(name);
        for (const d of docs) c.docs.set(d._id, d);
      }
    }
  }
  async connect() {}
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection(this, name));
    return this.collections.get(name);
  }
  dirty() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 500);
    this.timer.unref?.();
  }
  flush() {
    this.timer = null;
    if (!this.file) return;
    const out = {};
    for (const [name, c] of this.collections) out[name] = [...c.docs.values()];
    writeFileSync(this.file + '.tmp', JSON.stringify(out));
    renameSync(this.file + '.tmp', this.file);
  }
  async close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.flush();
    }
  }
}
