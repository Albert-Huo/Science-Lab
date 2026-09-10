'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

const OUTCOMES = new Set(['completed', 'client_aborted', 'upstream_timeout', 'upstream_error',
  'stream_incomplete', 'invalid_request', 'rate_limited', 'quota_unavailable', 'not_configured', 'internal_error']);
const SCOPES = new Set(['', 'ip_minute', 'ip_day', 'session_day', 'global_day', 'concurrency']);
const numeric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Optional bounded, best-effort anonymous NDJSON sink. Never retain request bodies. */
function createEventLogger({ path, maxQueue = 256, warn = message => console.warn(message) } = {}) {
  const queue = [];
  const capacity = Number.isSafeInteger(maxQueue) && maxQueue > 0 ? Math.min(maxQueue, 4096) : 256;
  let draining = null;
  const warnings = new Map();
  function warning(code) {
    if (Date.now() - (warnings.get(code) || 0) < 30000) return;
    warnings.set(code, Date.now());
    try { warn('[ai-events] ' + code); }
    catch { return; } // A failed diagnostics sink must not affect an AI request.
  }
  async function drain() {
    while (queue.length) {
      let handle;
      try {
        // Open for each append so rename-based rotation needs no process restart.
        // NONBLOCK also prevents a replaced FIFO from blocking a worker thread.
        handle = await fs.open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
          | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o640);
        if (!(await handle.stat()).isFile()) throw new Error('not_regular');
        await handle.writeFile(queue[0]);
      } catch { warning('write_unavailable'); }
      finally {
        if (handle) {
          try { await handle.close(); }
          catch { warning('write_unavailable'); }
        }
        queue.shift();
      }
    }
  }
  return {
    record(event) {
      if (!path) return false;
      if (queue.length >= capacity) { warning('queue_full'); return false; }
      try {
        const line = { version: 1, metricVersion: 2, time: new Date().toISOString(),
          outcome: OUTCOMES.has(event.outcome) ? event.outcome : 'internal_error',
          scope: SCOPES.has(event.scope) ? event.scope : '',
          experiment: typeof event.experiment === 'string' && /^[a-f0-9]{64}$/.test(event.experiment) ? event.experiment : '',
          status: numeric(event.status) !== null && event.status >= 100 && event.status <= 599 ? event.status : null,
          messages: numeric(event.messages), inputChars: numeric(event.inputChars), promptChars: numeric(event.promptChars),
          conversationChars: numeric(event.conversationChars), durationMs: numeric(event.durationMs) ?? 0,
          firstTokenMs: numeric(event.firstTokenMs) };
        queue.push(JSON.stringify(line) + '\n');
        if (!draining) draining = drain().finally(() => { draining = null; });
        return true;
      } catch { warning('invalid_event'); return false; }
    },
    async flush() { if (draining) await draining; },
  };
}

/** Observe complete SSE events with bounded retained text; forward every byte unchanged. */
function createSseObserver({ onFirstToken = () => {}, onDone = () => {}, onError = () => {} } = {}) {
  const decoder = new StringDecoder('utf8');
  const maxChars = 65536;
  let line = ''; let data = ''; let invalid = false; let cr = false;
  let tokenSeen = false; let doneSeen = false; let errorSeen = false; let firstChar = true;
  function protocolError() {
    if (!errorSeen && !doneSeen) { errorSeen = true; onError(); }
  }
  function endLine() {
    if (!line) {
      if (invalid) protocolError();
      if (!invalid && !errorSeen && !doneSeen && data) {
        const payload = data.slice(0, -1);
        if (payload === '[DONE]') {
          if (!doneSeen) { doneSeen = true; onDone(); }
        } else if (payload.trim()) {
          let parsed;
          try { parsed = JSON.parse(payload); }
          catch { protocolError(); }
          if (parsed?.error || parsed === null) protocolError();
          if (!errorSeen && !tokenSeen && Array.isArray(parsed?.choices) && parsed.choices.some(choice =>
            typeof choice?.delta?.content === 'string' && choice.delta.content.length > 0)) {
            tokenSeen = true; onFirstToken();
          }
        }
      }
      data = ''; invalid = false;
    } else if (!invalid && (line === 'data' || line.startsWith('data:'))) {
      let value = line === 'data' ? '' : line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      if (data.length + value.length + 1 > maxChars) { invalid = true; data = ''; }
      else data += value + '\n';
    }
    line = '';
  }
  function observe(text) {
    for (const char of text) {
      if (firstChar) { firstChar = false; if (char === '\ufeff') continue; }
      if (cr) { cr = false; if (char === '\n') continue; }
      if (char === '\r' || char === '\n') { endLine(); cr = char === '\r'; }
      else if (line.length < maxChars) line += char;
      else { invalid = true; data = ''; }
    }
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      observe(decoder.write(chunk));
      callback(null, chunk);
    },
    flush(callback) { observe(decoder.end()); callback(); },
  });
}

module.exports = { createEventLogger, createSseObserver };
