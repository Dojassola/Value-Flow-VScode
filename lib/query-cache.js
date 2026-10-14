'use strict';
const { FlowError, abortable } = require('./util');

/** Cache + in-flight deduplication + bounded REAL provider concurrency.
 * A timeout releases the consumer, not the worker slot. VS Code's executeCommand
 * does not expose provider cancellation; releasing a timed-out slot would permit
 * unbounded work to accumulate in the language server.
 */
class QueryCache {
  constructor({ concurrency = 4, timeoutMs = 8000, ttlMs = 15000, maxEntries = 500, log = () => {} } = {}) {
    Object.assign(this, { concurrency, timeoutMs, ttlMs, maxEntries, log });
    this.cache = new Map(); this.pending = new Map(); this.queue = []; this.active = 0; this.epoch = 0;
    this.stats = { requests: 0, cacheHits: 0, shared: 0, timeouts: 0, errors: 0 };
  }
  invalidate() { this.epoch++; this.cache.clear(); this.pending.clear(); }
  run(key, task, signal) {
    this.stats.requests++;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) {
      this.stats.cacheHits++;
      return abortable(Promise.resolve(cached.value), signal);
    }
    if (this.pending.has(key)) { this.stats.shared++; return abortable(this.pending.get(key), signal); }
    if (this.queue.length >= 128) return Promise.reject(new FlowError('BUSY', 'Provider queue is full. Cancel other analyses or retry later.'));
    const epoch = this.epoch;
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    const entry = { key, task, epoch, promise, resolve, reject, done: false, started: false, timer: null };
    entry.timer = setTimeout(() => {
      if (entry.done) return;
      entry.done = true; this.stats.timeouts++;
      if (this.pending.get(key) === promise) this.pending.delete(key);
      reject(new FlowError('PROVIDER_TIMEOUT', `Provider timed out after ${this.timeoutMs} ms. The language service may still be indexing.`));
      this.log(`Provider timeout: ${key.split('|')[0]}`);
      this.queue = this.queue.filter(item => item !== entry);
    }, this.timeoutMs);
    this.pending.set(key, promise);
    promise.then(() => {}, () => {}).finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
    this.queue.push(entry); this._pump();
    return abortable(promise, signal);
  }
  _pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const entry = this.queue.shift();
      if (entry.done) continue;
      entry.started = true; this.active++;
      Promise.resolve().then(entry.task).then(value => {
        if (entry.epoch === this.epoch && !entry.done && value != null && !(Array.isArray(value) && value.length === 0)) {
          this.cache.set(entry.key, { at: Date.now(), value });
          while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
        }
        if (!entry.done) {
          entry.done = true;
          if (this.pending.get(entry.key) === entry.promise) this.pending.delete(entry.key);
          entry.resolve(value);
        }
      }, error => {
        this.stats.errors++;
        if (!entry.done) {
          entry.done = true;
          if (this.pending.get(entry.key) === entry.promise) this.pending.delete(entry.key);
          entry.reject(error);
        }
      }).finally(() => { clearTimeout(entry.timer); this.active--; this._pump(); });
    }
  }
}
module.exports = { QueryCache };
