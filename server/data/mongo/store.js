// MongoDB adapter for the DocumentStore contract.
import { MongoClient } from 'mongodb';

class MongoCollection {
  constructor(col) {
    this.col = col;
  }
  ensureIndex(fields, opts = {}) {
    return this.col.createIndex(fields, opts);
  }
  async insertOne(doc) {
    await this.col.insertOne(doc);
    return doc;
  }
  async insertMany(docs) {
    if (docs.length) await this.col.insertMany(docs, { ordered: false });
  }
  findOne(filter = {}) {
    return this.col.findOne(filter);
  }
  find(filter = {}, opts = {}) {
    let cur = this.col.find(filter);
    if (opts.sort) cur = cur.sort(opts.sort);
    if (opts.skip) cur = cur.skip(opts.skip);
    if (opts.limit) cur = cur.limit(opts.limit);
    return cur.toArray();
  }
  count(filter = {}) {
    return this.col.countDocuments(filter);
  }
  async updateOne(filter, update, opts = {}) {
    const r = await this.col.updateOne(filter, update, { upsert: !!opts.upsert });
    return { matched: r.matchedCount, upserted: r.upsertedCount };
  }
  async updateMany(filter, update) {
    const r = await this.col.updateMany(filter, update);
    return { matched: r.matchedCount };
  }
  async bulkUpdate(ops) {
    if (!ops.length) return;
    await this.col.bulkWrite(
      ops.map((o) => ({ updateOne: { filter: o.filter, update: o.update, upsert: !!o.opts?.upsert } })),
      { ordered: false },
    );
  }
  async deleteOne(filter) {
    return (await this.col.deleteOne(filter)).deletedCount;
  }
  async deleteMany(filter = {}) {
    return (await this.col.deleteMany(filter)).deletedCount;
  }
}

export class MongoStore {
  constructor({ url, dbName }) {
    this.client = new MongoClient(url, { maxPoolSize: 20, serverSelectionTimeoutMS: 5000 });
    this.dbName = dbName;
    this.cols = new Map();
  }
  async connect() {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
  }
  collection(name) {
    if (!this.cols.has(name)) this.cols.set(name, new MongoCollection(this.db.collection(name)));
    return this.cols.get(name);
  }
  async close() {
    await this.client.close();
  }
}
