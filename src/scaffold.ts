/**
 * Scatter — Scaffold generator.
 *
 * Generates the complete JavaScript source string that runs inside every
 * scatter worker. The scaffold:
 *
 *   1. Injects user imports and the user function
 *   2. Installs error and shutdown listeners
 *   3. Waits for __SCATTER_INIT__, hydrates context, posts __SCATTER_INIT_ACK__
 *   4. Enters the appropriate execution loop for its mode:
 *      - oneshot  — run once and close
 *      - spawn    — run once (long-lived), with channel access
 *      - pool     — message loop, concurrency=1 (sequential)
 *      - pool     — message loop, concurrency>1 (semaphore-gated parallel)
 *      - max      — identical to pool but semantically auto-scaled by the host
 *
 * Since the scaffold runs inside a Blob worker, bare module specifiers cannot
 * be resolved. All shared-channel reconstruction logic is inlined.
 */

import type { ScaffoldMode } from './protocol.js';

export type { ScaffoldMode };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for generating a scaffold source string. */
export interface ScaffoldOptions {
  /** The user's function, already serialized via `.toString()`. */
  readonly fnSource: string;

  /** Import statements to inject verbatim at the top of the worker module. */
  readonly imports: readonly string[];

  /** Scaffold mode — determines the boot protocol and execution loop. */
  readonly mode: ScaffoldMode;

  /**
   * Maximum number of tasks processed concurrently per worker.
   * Only meaningful for `pool` and `max` modes. Default: `1`.
   */
  readonly concurrency?: number;
}

// ---------------------------------------------------------------------------
// Inlined channel reconstruction (emitted verbatim into every scaffold)
// ---------------------------------------------------------------------------

/**
 * Minimal inline source for reconstructing a SharedChannel from a ChannelMeta
 * descriptor. Emitted verbatim into the scaffold so Blob workers never need to
 * resolve bare specifiers.
 *
 * Implements the same ring-buffer layout documented in ring-buffer.ts:
 *   Offset  Size  Field
 *   0       4     Write cursor (Uint32, atomic)
 *   4       4     Read cursor  (Uint32, atomic)
 *   8       4     Closed flag  (Uint32, 0=open 1=closed, atomic)
 *   12      N     Data region  (Uint8Array)
 */
const INLINE_CHANNEL_SOURCE = /* js */ `
// ---------------------------------------------------------------------------
// Inline channel reconstruction (no bare imports — Blob worker compatible)
// ---------------------------------------------------------------------------

const __enc = new TextEncoder();
const __dec = new TextDecoder();

function __resolveCodec(name) {
  switch (name) {
    case 'raw':        return { encode: v => v, decode: b => b };
    case 'number':     return {
      encode(v) { const f = new Float64Array(1); f[0] = v; return new Uint8Array(f.buffer); },
      decode(b) { return new Float64Array(b.buffer, b.byteOffset, 1)[0]; },
    };
    case 'string':     return { encode: v => __enc.encode(v), decode: b => __dec.decode(b) };
    case 'json':       return {
      encode: v => __enc.encode(JSON.stringify(v)),
      decode: b => JSON.parse(__dec.decode(b)),
    };
    case 'structured': return typeof Bun !== 'undefined'
      ? { encode: v => Bun.serialize(v), decode: b => Bun.deserialize(b) }
      : { encode: v => __enc.encode(JSON.stringify(v)), decode: b => JSON.parse(__dec.decode(b)) };
    default: throw new TypeError('scatter: unknown codec "' + name + '"');
  }
}

// Ring-buffer offsets (mirrors ring-buffer.ts layout)
const __RB_WRITE  = 0; // Uint32 index
const __RB_READ   = 1; // Uint32 index
const __RB_CLOSED = 2; // Uint32 index (0=open, 1=closed)
const __RB_HEADER = 12; // bytes

function __channelFromMeta(meta) {
  const codec  = __resolveCodec(meta.codecName);
  const ringU32 = new Uint32Array(meta.ringSab);
  const ringU8 = new Uint8Array(meta.ringSab);
  const sig32  = new Int32Array(meta.signalSab);
  const cap    = meta.capacity;
  let _closed  = false;

  // Wrapped read/write: handles length-prefix and payload bytes that
  // straddle the circular buffer boundary. Every byte index is masked
  // with % cap so we never overrun the data region.
  function _wrappedReadU32(cursor) {
    const b0 = ringU8[__RB_HEADER + ((cursor)     % cap)];
    const b1 = ringU8[__RB_HEADER + ((cursor + 1) % cap)];
    const b2 = ringU8[__RB_HEADER + ((cursor + 2) % cap)];
    const b3 = ringU8[__RB_HEADER + ((cursor + 3) % cap)];
    return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  }
  function _wrappedWriteU32(cursor, value) {
    ringU8[__RB_HEADER + ((cursor)     % cap)] = (value >>> 24) & 0xff;
    ringU8[__RB_HEADER + ((cursor + 1) % cap)] = (value >>> 16) & 0xff;
    ringU8[__RB_HEADER + ((cursor + 2) % cap)] = (value >>>  8) & 0xff;
    ringU8[__RB_HEADER + ((cursor + 3) % cap)] =  value         & 0xff;
  }

  function _push(data) {
    const wc    = Atomics.load(ringU32, __RB_WRITE);
    const rc    = Atomics.load(ringU32, __RB_READ);
    const used  = (wc - rc) >>> 0;
    const need  = 4 + data.byteLength;
    if (used + need > cap) return false;
    _wrappedWriteU32(wc, data.byteLength);
    const startOff = (wc + 4) % cap;
    const endOff = startOff + data.byteLength;
    if (endOff <= cap) {
      ringU8.set(data, __RB_HEADER + startOff);
    } else {
      const first = cap - startOff;
      ringU8.set(data.subarray(0, first), __RB_HEADER + startOff);
      ringU8.set(data.subarray(first), __RB_HEADER);
    }
    Atomics.store(ringU32, __RB_WRITE, (wc + need) >>> 0);
    Atomics.notify(sig32, 0, 1);
    return true;
  }

  function _pop() {
    const wc = Atomics.load(ringU32, __RB_WRITE);
    const rc = Atomics.load(ringU32, __RB_READ);
    if (wc === rc) return null;
    const len  = _wrappedReadU32(rc);
    const data = new Uint8Array(len);
    const startOff = (rc + 4) % cap;
    const endOff = startOff + len;
    if (endOff <= cap) {
      data.set(ringU8.subarray(__RB_HEADER + startOff, __RB_HEADER + endOff));
    } else {
      const first = cap - startOff;
      data.set(ringU8.subarray(__RB_HEADER + startOff, __RB_HEADER + cap));
      data.set(ringU8.subarray(__RB_HEADER, __RB_HEADER + len - first), first);
    }
    Atomics.store(ringU32, __RB_READ, (rc + 4 + len) >>> 0);
    return data;
  }

  return {
    write(value) {
      if (_closed || Atomics.load(ringU32, __RB_CLOSED) === 1) throw new Error('Channel is closed');
      return _push(codec.encode(value));
    },
    writeBlocking(value, timeout = Infinity) {
      if (_closed || Atomics.load(ringU32, __RB_CLOSED) === 1) throw new Error('Channel is closed');
      const encoded = codec.encode(value);
      const deadline = timeout === Infinity ? Infinity : Date.now() + timeout;
      while (true) {
        if (_push(encoded)) return true;
        if (deadline === Infinity) {
          Atomics.wait(sig32, 0, Atomics.load(sig32, 0));
        } else {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return false;
          Atomics.wait(sig32, 0, Atomics.load(sig32, 0), Math.min(remaining, 1));
        }
      }
    },
    read() {
      const raw = _pop();
      return raw === null ? null : codec.decode(raw);
    },
    readBlocking(timeout = Infinity) {
      const deadline = timeout === Infinity ? Infinity : Date.now() + timeout;
      while (true) {
        const raw = _pop();
        if (raw !== null) return codec.decode(raw);
        if (Atomics.load(ringU32, __RB_CLOSED) === 1) return null;
        if (deadline === Infinity) {
          Atomics.wait(sig32, 0, Atomics.load(sig32, 0));
        } else {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return null;
          Atomics.wait(sig32, 0, Atomics.load(sig32, 0), Math.min(remaining, 1));
        }
      }
    },
    async readAsync() {
      while (true) {
        const raw = _pop();
        if (raw !== null) return codec.decode(raw);
        if (Atomics.load(ringU32, __RB_CLOSED) === 1) return null;
        await Atomics.waitAsync(sig32, 0, Atomics.load(sig32, 0)).value;
      }
    },
    close() {
      _closed = true;
      Atomics.store(ringU32, __RB_CLOSED, 1);
      Atomics.notify(sig32, 0, Infinity);
    },
    get closed() { return _closed || Atomics.load(ringU32, __RB_CLOSED) === 1; },
  };
}
`.trimStart();

// ---------------------------------------------------------------------------
// Error serialization helper (emitted into every scaffold)
// ---------------------------------------------------------------------------

const INLINE_SERIALIZE_ERROR_SOURCE = /* js */ `
function __serializeError(err, _depth) {
  _depth = _depth || 0;
  const MAX_DEPTH = 10;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack || (err.name + ': ' + err.message),
      cause: err.cause !== undefined && _depth < MAX_DEPTH
        ? __serializeError(err.cause, _depth + 1)
        : undefined,
    };
  }
  const msg = typeof err === 'string' ? err : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
  return { name: 'UnknownError', message: msg, stack: 'UnknownError: ' + msg };
}
`.trimStart();

// ---------------------------------------------------------------------------
// Shared preamble sections
// ---------------------------------------------------------------------------

/** Returns the import block (one statement per import, already newline-separated). */
function buildImportBlock(imports: readonly string[]): string {
  return imports.length > 0 ? imports.join('\n') + '\n\n' : '';
}

/** Returns the common top-of-scaffold source shared by all modes. */
function buildCommonPreamble(fnSource: string, imports: readonly string[]): string {
  return /* js */ `${buildImportBlock(imports)}${INLINE_CHANNEL_SOURCE}
${INLINE_SERIALIZE_ERROR_SOURCE}
const __fn = ${fnSource};

self.addEventListener('unhandledrejection', (event) => {
  self.postMessage({
    __type: '__SCATTER_ERROR__',
    error: __serializeError(event.reason),
  });
});
`;
}

// ---------------------------------------------------------------------------
// Mode-specific execution loops
// ---------------------------------------------------------------------------

/** oneshot: run once, post RESULT/ERROR. Host calls terminate(). */
function buildOneshotLoop(): string {
  return /* js */ `
self.addEventListener('message', async ({ data: msg }) => {
  if (msg.__type === '__SCATTER_SHUTDOWN__') {
    self.postMessage({ __type: '__SCATTER_SHUTDOWN_ACK__' });
    return;
  }
  if (msg.__type !== '__SCATTER_INIT__') return;

  const { threadId, data, channelMeta } = msg;

  const ctx = { data: data || {}, threadId, workerIndex: 0, workerCount: 1 };
  self.postMessage({ __type: '__SCATTER_INIT_ACK__', threadId });

  try {
    const value = await __fn(ctx);
    self.postMessage({ __type: '__SCATTER_RESULT__', value });
  } catch (err) {
    self.postMessage({ __type: '__SCATTER_ERROR__', error: __serializeError(err) });
  }
}, { once: true });
`.trimStart();
}

/** spawn: long-lived worker with reconstructed SharedChannels. Host calls terminate(). */
function buildSpawnLoop(): string {
  return /* js */ `
self.addEventListener('message', async ({ data: msg }) => {
  if (msg.__type === '__SCATTER_SHUTDOWN__') {
    self.postMessage({ __type: '__SCATTER_SHUTDOWN_ACK__' });
    return;
  }
  if (msg.__type !== '__SCATTER_INIT__') return;

  const { threadId, data, channelMeta } = msg;

  const __channels = {};
  for (const [name, meta] of Object.entries(channelMeta || {})) {
    __channels[name] = __channelFromMeta(meta);
  }

  const ctx = {
    data: data || {},
    threadId,
    workerIndex: 0,
    workerCount: 1,
    channel(name) {
      if (!Object.prototype.hasOwnProperty.call(__channels, name)) {
        throw new Error('scatter: unknown channel "' + name + '"');
      }
      return __channels[name];
    },
  };

  self.postMessage({ __type: '__SCATTER_INIT_ACK__', threadId });

  let __shutdownRequested = false;
  const __shutdownPromise = new Promise((resolve) => {
    self.addEventListener('message', ({ data: m }) => {
      if (m.__type === '__SCATTER_SHUTDOWN__') { __shutdownRequested = true; resolve(); }
    });
  });

  try {
    await Promise.race([__fn(ctx), __shutdownPromise]);
    self.postMessage({ __type: '__SCATTER_RESULT__', value: undefined });
  } catch (err) {
    self.postMessage({ __type: '__SCATTER_ERROR__', error: __serializeError(err) });
  } finally {
    // Note: The inner shutdown listener is intentionally not removed.
    // Since self.close() is no longer called, the listener would leak,
    // but the host terminates the worker anyway, making this harmless.
    for (const ch of Object.values(__channels)) {
      try { ch.close(); } catch {}
    }
    if (__shutdownRequested) {
      self.postMessage({ __type: '__SCATTER_SHUTDOWN_ACK__' });
    }
  }
}, { once: true });
`.trimStart();
}

/**
 * pool/max with concurrency=1 (sequential, simplest path).
 * One task at a time; results posted in order.
 */
function buildPoolLoopSequential(): string {
  return /* js */ `
self.addEventListener('message', ({ data: msg }) => {
  if (msg.__type !== '__SCATTER_INIT__') return;

  const { threadId, data, channelMeta } = msg;
  const ctx = { data: data || {}, threadId, workerIndex: (data && data.__workerIndex) || 0, workerCount: (data && data.__workerCount) || 1 };
  self.postMessage({ __type: '__SCATTER_INIT_ACK__', threadId });

  let __shutdown = false;

  self.addEventListener('message', async ({ data: task }) => {
    if (task.__type === '__SCATTER_SHUTDOWN__') {
      __shutdown = true;
      self.postMessage({ __type: '__SCATTER_SHUTDOWN_ACK__' });
      return;
    }

    if (task.__type === '__SCATTER_TASK__') {
      const { taskId, input } = task;
      try {
        const value = await __fn(ctx, input);
        self.postMessage({ __type: '__SCATTER_TASK_RESULT__', taskId, value });
      } catch (err) {
        self.postMessage({ __type: '__SCATTER_TASK_ERROR__', taskId, error: __serializeError(err) });
      }
      return;
    }

    if (task.__type === '__SCATTER_TASK_BATCH__') {
      for (const { taskId, input } of task.tasks) {
        if (__shutdown) break;
        try {
          const value = await __fn(ctx, input);
          self.postMessage({ __type: '__SCATTER_TASK_RESULT__', taskId, value });
        } catch (err) {
          self.postMessage({ __type: '__SCATTER_TASK_ERROR__', taskId, error: __serializeError(err) });
        }
      }
    }
  });
}, { once: true });
`.trimStart();
}

/**
 * pool/max with concurrency>1 (parallel, semaphore-gated).
 * Up to `concurrency` tasks run simultaneously; results are posted as they complete.
 */
function buildPoolLoopConcurrent(concurrency: number): string {
  return /* js */ `
self.addEventListener('message', ({ data: msg }) => {
  if (msg.__type !== '__SCATTER_INIT__') return;

  const { threadId, data, channelMeta } = msg;
  const ctx = { data: data || {}, threadId, workerIndex: (data && data.__workerIndex) || 0, workerCount: (data && data.__workerCount) || 1 };
  self.postMessage({ __type: '__SCATTER_INIT_ACK__', threadId });

  // Semaphore — allows at most ${concurrency} concurrent task executions.
  const __CONCURRENCY = ${concurrency};
  let __running = 0;
  const __queue = [];
  let __shutdown = false;

  function __next() {
    while (__running < __CONCURRENCY && __queue.length > 0 && !__shutdown) {
      const run = __queue.shift();
      __running++;
      run().finally(() => {
        __running--;
        __next();
      });
    }
  }

  function __enqueue(taskId, input) {
    __queue.push(async () => {
      try {
        const value = await __fn(ctx, input);
        self.postMessage({ __type: '__SCATTER_TASK_RESULT__', taskId, value });
      } catch (err) {
        self.postMessage({ __type: '__SCATTER_TASK_ERROR__', taskId, error: __serializeError(err) });
      }
    });
    __next();
  }

  self.addEventListener('message', ({ data: task }) => {
    if (task.__type === '__SCATTER_SHUTDOWN__') {
      __shutdown = true;
      // Drain queue — reject remaining enqueued (not yet started) tasks.
      while (__queue.length > 0) __queue.shift();
      if (__running === 0) {
        self.postMessage({ __type: '__SCATTER_SHUTDOWN_ACK__' });
      } else {
        // Wait for in-flight tasks to settle before acking.
        const interval = setInterval(() => {
          if (__running === 0) {
            clearInterval(interval);
            self.postMessage({ __type: '__SCATTER_SHUTDOWN_ACK__' });
          }
        }, 5);
      }
      return;
    }

    if (task.__type === '__SCATTER_TASK__') {
      __enqueue(task.taskId, task.input);
      return;
    }

    if (task.__type === '__SCATTER_TASK_BATCH__') {
      for (const { taskId, input } of task.tasks) {
        __enqueue(taskId, input);
      }
    }
  });
}, { once: true });
`.trimStart();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the complete JavaScript source for a scatter worker.
 *
 * The returned string is a self-contained ES module that can be turned into a
 * `Blob` and loaded via `URL.createObjectURL` as a `Worker`.
 *
 * All shared-channel reconstruction logic is inlined so the scaffold works
 * inside Blob workers that cannot resolve bare module specifiers.
 *
 * @example
 * ```ts
 * const src = generateScaffold({
 *   fnSource: fn.toString(),
 *   imports: ["import { something } from 'some-module';"],
 *   mode: 'pool',
 *   concurrency: 4,
 * });
 * const blob = new Blob([src], { type: 'application/javascript' });
 * const url  = URL.createObjectURL(blob);
 * const worker = new Worker(url);
 * ```
 */
export function generateScaffold(options: ScaffoldOptions): string {
  const { fnSource, imports, mode, concurrency = 1 } = options;

  const preamble = buildCommonPreamble(fnSource, imports);

  switch (mode) {
    case 'oneshot': {
      return preamble + buildOneshotLoop();
    }
    case 'spawn': {
      return preamble + buildSpawnLoop();
    }
    case 'pool':
    case 'max': {
      const loop = concurrency > 1
        ? buildPoolLoopConcurrent(concurrency)
        : buildPoolLoopSequential();
      return preamble + loop;
    }
    default: {
      throw new TypeError(`scatter: unknown scaffold mode "${mode as string}"`);
    }
  }
}
