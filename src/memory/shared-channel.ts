/**
 * Scatter — SharedChannel contract and factory.
 *
 * High-level typed channels for cross-thread communication.
 * Built on SharedRingBuffer (data transport) + AtomicSignal (wake/sleep).
 *
 * Channels are unidirectional by design: one side writes, the other reads.
 * The `direction` field on {@link ChannelDef} determines which end of the
 * channel is writable on the main thread vs the worker:
 *
 *   - `'in'`  — main thread writes, worker reads
 *   - `'out'` — worker writes, main thread reads
 *
 * For bidirectional communication, declare two channels with opposite directions.
 *
 * @example
 * ```ts
 * import { createChannel } from './shared-channel.js';
 *
 * // Producer side
 * const ch = createChannel<number>({ codec: 'number' });
 * ch.write(42);
 *
 * // Consumer side (reconstructed in worker from meta)
 * const worker = channelFromMeta<number>(ch.meta);
 * const value = worker.read(); // 42
 * ```
 */

import type { Codec, CodecLike } from './codec.js';
import { resolveCodec } from './codec.js';
import type { SharedRingBuffer } from './ring-buffer.js';
import { createRingBuffer, ringBufferFromBuffer } from './ring-buffer.js';
import type { AtomicSignal } from './atomic-signal.js';
import { createAtomicSignal, atomicSignalFromBuffer } from './atomic-signal.js';
import { ChannelClosedError, ChannelFullError } from '../error.js';

// ---------------------------------------------------------------------------
// Directional channel interfaces
// ---------------------------------------------------------------------------

/**
 * The consumer side of a channel. Only supports reading.
 *
 * Obtained by the side that declared `direction: 'in'` on the worker side,
 * or `direction: 'out'` on the main-thread side.
 *
 * @example
 * ```ts
 * // Worker receives ReadableChannel for 'in' channels
 * for await (const task of ctx.channel('tasks')) {
 *   process(task);
 * }
 * ```
 */
export interface ReadableChannel<T> {
  /**
   * Non-blocking read. Returns the next decoded value or `null` if empty.
   */
  read(): T | null;

  /**
   * Blocking read. Waits until data is available or timeout expires.
   * Uses `Atomics.wait` — blocks the calling thread (suitable for workers).
   *
   * @returns The decoded value, or `null` if timed out or channel closed and drained.
   */
  readBlocking(timeout?: number): T | null;

  /**
   * Async read. Waits without blocking the thread.
   * Uses `Atomics.waitAsync` — safe on any thread including the main thread.
   *
   * @returns The decoded value, or `null` if the channel is closed and drained.
   */
  readAsync(): Promise<T | null>;

  /**
   * Read up to `maxCount` messages without blocking.
   * Useful for throughput-oriented consumers that want to drain a burst.
   *
   * @returns An array of decoded values (may be empty).
   */
  readBatch(maxCount: number): T[];

  /**
   * Async iterator. Yields values until the channel is closed and drained.
   *
   * Enables `for await (const msg of channel)` loops and is compatible with
   * `Stream.fromAsyncIterable` in Effect and similar libraries.
   *
   * @example
   * ```ts
   * for await (const msg of channel) {
   *   console.log(msg);
   * }
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;

  /**
   * Dispose the channel. Equivalent to `close()` on the full channel.
   * Enables `using channel = createChannel()` syntax.
   */
  [Symbol.dispose](): void;

  /** Whether the channel has been closed. */
  readonly closed: boolean;
}

/**
 * The producer side of a channel. Only supports writing.
 *
 * Obtained by the side that declared `direction: 'in'` on the main thread,
 * or `direction: 'out'` on the worker side.
 *
 * @example
 * ```ts
 * // Main thread writes to an 'in' channel
 * const tasks: WritableChannel<Task> = handle.channels.tasks;
 * tasks.write({ id: 1, value: 42 });
 * ```
 */
export interface WritableChannel<T> {
  /**
   * Non-blocking write. Encodes and pushes the value to the ring buffer.
   *
   * @throws {ChannelClosedError} if the channel has been closed.
   * @throws {ChannelFullError} if the ring buffer is full (backpressure).
   * Use {@link tryWrite} if you prefer a boolean result instead of a throw.
   */
  write(value: T): void;

  /**
   * Non-blocking write that returns a boolean instead of throwing on full.
   *
   * @returns `true` if written, `false` if the ring is full.
   * @throws {ChannelClosedError} if the channel has been closed.
   */
  tryWrite(value: T): boolean;

  /**
   * Blocking write. Retries until space is available or timeout expires.
   * Uses `Atomics.wait` between retries — yields the thread, no spin loop.
   *
   * @returns `true` if written, `false` if timed out.
   * @throws {ChannelClosedError} if the channel has been closed.
   */
  writeBlocking(value: T, timeout?: number): boolean;

  /**
   * Close the channel from the producer side.
   * - No further writes are accepted after this call.
   * - The consumer can still drain all buffered data, then receives `null`.
   * - Wakes any threads blocked in `readBlocking` / `readAsync`.
   */
  close(): void;

  /**
   * Dispose the channel. Equivalent to `close()`.
   * Enables `using channel = createChannel()` syntax.
   */
  [Symbol.dispose](): void;

  /** Whether the channel has been closed. */
  readonly closed: boolean;
}

/**
 * Full channel — both producer and consumer sides.
 *
 * Returned by {@link createChannel} and {@link channelFromMeta}. Internally
 * the entity that creates the channel holds both sides; the directional
 * interfaces ({@link ReadableChannel} / {@link WritableChannel}) are obtained
 * by casting for the appropriate thread side.
 *
 * @example
 * ```ts
 * const ch = createChannel<string>({ codec: 'string' });
 * ch.write('hello');
 * ch.read(); // 'hello'
 * ch.close();
 * ```
 */
export interface SharedChannel<T> extends ReadableChannel<T>, WritableChannel<T> {
  /**
   * The raw SharedArrayBuffers backing this channel.
   * Used to pass the channel across the worker boundary.
   */
  readonly transferables: ChannelTransferables;

  /**
   * Full metadata needed to reconstruct this channel on another thread via
   * {@link channelFromMeta}.
   */
  readonly meta: ChannelMeta;
}

// ---------------------------------------------------------------------------
// Transfer metadata (serialized across the worker boundary)
// ---------------------------------------------------------------------------

/** The raw SharedArrayBuffers that back a channel. */
export interface ChannelTransferables {
  readonly ring: SharedArrayBuffer;
  readonly signal: SharedArrayBuffer;
}

/** Metadata needed to reconstruct a channel on the worker side. */
export interface ChannelMeta {
  readonly ringSab: SharedArrayBuffer;
  readonly signalSab: SharedArrayBuffer;
  readonly capacity: number;
  readonly codecName: string;
}

// ---------------------------------------------------------------------------
// Channel creation options
// ---------------------------------------------------------------------------

/** Options for {@link createChannel}. */
export interface ChannelOptions<T> {
  /**
   * Ring buffer capacity in bytes. Default: 65536 (64 KB).
   */
  readonly capacity?: number;

  /**
   * Codec for serializing values. Can be a built-in name or a custom Codec.
   * Default: `'structured'`.
   */
  readonly codec?: CodecLike<T>;
}

// ---------------------------------------------------------------------------
// Channel definition (for thread.spawn channel maps)
// ---------------------------------------------------------------------------

/**
 * Declarative channel definition used in `scatter.spawn({ channels: { ... } })`.
 *
 * This is a *description* of a channel, not the channel itself.
 * scatter creates the actual SharedChannel from this at spawn time.
 *
 * @example
 * ```ts
 * const handle = scatter.spawn(workerFn, {
 *   channels: {
 *     tasks:   { direction: 'in',  codec: 'json' },
 *     results: { direction: 'out', codec: 'json' },
 *   },
 * });
 * ```
 */
export interface ChannelDef<T = unknown> {
  /**
   * Direction of data flow:
   * - `'in'`  — main thread writes, worker reads
   * - `'out'` — worker writes, main thread reads
   */
  readonly direction: 'in' | 'out';

  /** Ring buffer capacity in bytes. Default: 65536 (64 KB). */
  readonly capacity?: number;

  /** Codec for value serialization. Default: `'structured'`. */
  readonly codec?: CodecLike<T>;

  /**
   * Phantom field — never set at runtime.
   * Exists purely to carry the type parameter `T` through the type system.
   */
  readonly __phantom?: T;
}

/** A record of named channel definitions. */
export type ChannelDefinitions = Record<string, ChannelDef>;

/** Extract the value type from a ChannelDef. */
export type InferChannelType<D> = D extends ChannelDef<infer T> ? T : unknown;

/**
 * Channels as seen from the **main thread** side.
 *
 * - `'in'`  channels are {@link WritableChannel} (main writes, worker reads).
 * - `'out'` channels are {@link ReadableChannel} (worker writes, main reads).
 *
 * @example
 * ```ts
 * type MyChannels = MainSideChannels<{
 *   tasks:   ChannelDef<Task>   & { direction: 'in'  };
 *   results: ChannelDef<Result> & { direction: 'out' };
 * }>;
 * // → { tasks: WritableChannel<Task>; results: ReadableChannel<Result> }
 * ```
 */
export type MainSideChannels<T extends ChannelDefinitions> = {
  readonly [K in keyof T]: T[K]['direction'] extends 'in'
    ? WritableChannel<InferChannelType<T[K]>>
    : ReadableChannel<InferChannelType<T[K]>>;
};

/**
 * Channels as seen from the **worker** side.
 *
 * - `'in'`  channels are {@link ReadableChannel} (main writes, worker reads).
 * - `'out'` channels are {@link WritableChannel} (worker writes, main reads).
 *
 * @example
 * ```ts
 * type MyChannels = WorkerSideChannels<{
 *   tasks:   ChannelDef<Task>   & { direction: 'in'  };
 *   results: ChannelDef<Result> & { direction: 'out' };
 * }>;
 * // → { tasks: ReadableChannel<Task>; results: WritableChannel<Result> }
 * ```
 */
export type WorkerSideChannels<T extends ChannelDefinitions> = {
  readonly [K in keyof T]: T[K]['direction'] extends 'in'
    ? ReadableChannel<InferChannelType<T[K]>>
    : WritableChannel<InferChannelType<T[K]>>;
};

// ---------------------------------------------------------------------------
// Internal: channel implementation builder
// ---------------------------------------------------------------------------

/**
 * Build a {@link SharedChannel} implementation from an already-created ring,
 * signal, and resolved codec. The same builder is used by both
 * {@link createChannel} and {@link channelFromMeta}.
 *
 * @internal
 */
function buildChannel<T>(
  ring: SharedRingBuffer,
  signal: AtomicSignal,
  codec: Codec<T>,
): SharedChannel<T> {
  // Spin-wait ceiling for writeBlocking before each Atomics.wait sleep.
  const SPIN_LIMIT = 16;
  // Sleep slice for writeBlocking when no timeout is specified.
  const WRITE_SLEEP_MS = 1;

  function assertOpen(): void {
    if (ring.closed) throw new ChannelClosedError();
  }

  function tryWriteInternal(value: T): boolean {
    assertOpen();
    const encoded = codec.encode(value);
    const pushed = ring.push(encoded);
    if (pushed) signal.notify(1);
    return pushed;
  }

  const channel: SharedChannel<T> = {
    get closed(): boolean {
      return ring.closed;
    },

    get transferables(): ChannelTransferables {
      return { ring: ring.buffer, signal: signal.buffer };
    },

    get meta(): ChannelMeta {
      return {
        ringSab: ring.buffer,
        signalSab: signal.buffer,
        capacity: ring.capacity,
        codecName: codec.name,
      };
    },

    // -----------------------------------------------------------------------
    // Write side
    // -----------------------------------------------------------------------

    write(value: T): void {
      const ok = tryWriteInternal(value);
      if (!ok) throw new ChannelFullError(0);
    },

    tryWrite(value: T): boolean {
      return tryWriteInternal(value);
    },

    writeBlocking(value: T, timeout?: number): boolean {
      assertOpen();
      const deadline = timeout !== undefined ? Date.now() + timeout : Infinity;
      const encoded = codec.encode(value);

      let spins = 0;
      while (true) {
        assertOpen();

        if (ring.push(encoded)) {
          signal.notify(1);
          return true;
        }

        const now = Date.now();
        if (now >= deadline) return false;

        // Spin a few times before yielding to avoid overhead on short waits.
        spins++;
        if (spins < SPIN_LIMIT) continue;
        spins = 0;

        const remaining = deadline === Infinity ? WRITE_SLEEP_MS : Math.min(deadline - now, WRITE_SLEEP_MS);
        signal.wait(remaining);
      }
    },

    close(): void {
      ring.close();
      // Wake all readers so they can drain and observe the closed state.
      signal.notify(Infinity);
    },

    [Symbol.dispose](): void {
      channel.close();
    },

    // -----------------------------------------------------------------------
    // Read side
    // -----------------------------------------------------------------------

    read(): T | null {
      const raw = ring.pop();
      return raw !== null ? codec.decode(raw) : null;
    },

    readBlocking(timeout?: number): T | null {
      const deadline = timeout !== undefined ? Date.now() + timeout : Infinity;

      while (true) {
        const raw = ring.pop();
        if (raw !== null) return codec.decode(raw);

        // Channel closed and fully drained — signal end-of-stream.
        if (ring.closed) return null;

        const now = Date.now();
        if (now >= deadline) return null;

        const remaining = deadline === Infinity ? Infinity : deadline - now;
        signal.wait(remaining);
        signal.reset();
      }
    },

    async readAsync(): Promise<T | null> {
      while (true) {
        const raw = ring.pop();
        if (raw !== null) return codec.decode(raw);

        if (ring.closed) return null;

        await signal.waitAsync();
        signal.reset();
      }
    },

    readBatch(maxCount: number): T[] {
      const results: T[] = [];
      for (let i = 0; i < maxCount; i++) {
        const raw = ring.pop();
        if (raw === null) break;
        results.push(codec.decode(raw));
      }
      return results;
    },

    async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
      while (true) {
        const value = await channel.readAsync();
        if (value === null) return;
        yield value;
      }
    },
  };

  return channel;
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create a new {@link SharedChannel} with freshly allocated SharedArrayBuffers.
 *
 * Both the ring buffer and signal are created here. The channel is ready for
 * immediate use. To pass the channel to a worker thread, send `channel.meta`
 * via `postMessage` and reconstruct it with {@link channelFromMeta}.
 *
 * @example
 * ```ts
 * const ch = createChannel<{ id: number }>({ codec: 'json', capacity: 128 * 1024 });
 *
 * // Producer (main thread)
 * ch.write({ id: 1 });
 *
 * // Consumer (worker thread — after receiving ch.meta)
 * const wch = channelFromMeta<{ id: number }>(ch.meta);
 * const msg = wch.readBlocking(5000);
 * ```
 */
export function createChannel<T>(options?: ChannelOptions<T>): SharedChannel<T> {
  const codec = resolveCodec<T>(options?.codec ?? 'structured');
  const ring = createRingBuffer({ capacity: options?.capacity });
  const signal = createAtomicSignal();
  return buildChannel(ring, signal, codec);
}

/**
 * Reconstruct a {@link SharedChannel} from existing {@link ChannelMeta}.
 *
 * Used on the worker side to hydrate the channel from the SharedArrayBuffers
 * passed in the `INIT` protocol message.
 *
 * @example
 * ```ts
 * // Inside a worker, from the init message
 * const ch = channelFromMeta<Task>(initMsg.channelMeta['tasks']);
 * const task = ch.readBlocking();
 * ```
 */
export function channelFromMeta<T>(meta: ChannelMeta): SharedChannel<T> {
  const codec = resolveCodec<T>(meta.codecName as CodecLike<T>);
  const ring = ringBufferFromBuffer(meta.ringSab);
  const signal = atomicSignalFromBuffer(meta.signalSab);
  return buildChannel(ring, signal, codec);
}
