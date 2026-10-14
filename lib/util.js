'use strict';
const crypto = require('node:crypto');

class FlowError extends Error {
  constructor(code, message, details) { super(message); this.name = 'FlowError'; this.code = code; this.details = details; }
}
function fail(code, message, details) { throw new FlowError(code, message, details); }
function checkAbort(signal) { if (signal?.aborted) fail('CANCELLED', 'Analysis cancelled.'); }
function bounded(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_ARGUMENT', `Expected an integer from ${min} to ${max}.`);
  return value;
}
function locKey(loc) { return `${loc.uri}:${loc.line}:${loc.column}`; }
function idFor(prefix, value) { return prefix + ':' + crypto.createHash('sha256').update(value).digest('hex').slice(0, 24); }
function errorInfo(err) { return { code: err?.code || 'ANALYSIS_ERROR', message: err?.message || String(err), ...(err?.details ? { details: err.details } : {}) }; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function abortable(promise, signal) {
  if (!signal) return promise;
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new FlowError('CANCELLED', 'Analysis cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
module.exports = { FlowError, fail, checkAbort, bounded, locKey, idFor, errorInfo, clone, abortable };
