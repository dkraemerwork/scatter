/**
 * Scatter — AtomicSignal implementation.
 *
 * Lowest-level synchronization primitive. A single Int32 flag backed by a
 * 4-byte SharedArrayBuffer, driven entirely by `Atomics.wait` /
 * `Atomics.notify` / `Atomics.load` / `Atomics.store`.
 *
 * Memory layout: 4 bytes (one Int32 cell at index 0).
 *   value 0 = idle
 *   value 1 = signaled
 *
 * Factory functions:
 *   - {@link createAtomicSignal}      — allocates a fresh SAB.
 *   - {@link atomicSignalFromBuffer}  — wraps an existing SAB (worker side).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Byte size of the underlying SharedArrayBuffer. */
const SIGNAL_BUFFER_BYTES = 4;

/** Int32Array cell index for the signal flag. */
const SIGNAL_INDEX = 0;

/** Idle state — no pending notification. */
const STATE_IDLE = 0;

/** Signaled state — a notification has been stored. */
const STATE_SIGNALED = 1;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * A lightweight one-shot (auto-resettable) atomic flag for cross-thread
 * synchronization between a Bun main thread and worker threads.
 *
 * Implements {@link Disposable} so it can be used with `using`:
 * ```ts
 * using signal = createAtomicSignal();
 * ```
 */
export interface AtomicSignal {
  /**
   * Block the calling thread until the signal fires or the timeout expires.
   *
   * Uses `Atomics.wait` — safe on worker threads, forbidden on the browser
   * main thread (not applicable in Bun workers).
   *
   * @param timeout Maximum milliseconds to wait. Omit (or pass `Infinity`)
   *   to wait indefinitely.
   * @returns `'ok'` if woken by notify, `'timed-out'` if timeout expired.
   *
   * @example
   * ```ts
   * // In a worker thread:
   * const result = signal.wait(5000);
   * if (result === 'timed-out') console.error('No response in 5 s');
   * ```
   */
  wait(timeout?: number): 'ok' | 'timed-out';

  /**
   * Non-blocking async wait. Resolves when notified or on timeout.
   *
   * Uses `Atomics.waitAsync` — safe on any thread including the main thread.
   *
   * @param timeout Maximum milliseconds to wait. Omit (or pass `Infinity`)
   *   to wait indefinitely.
   * @returns Promise resolving to `'ok'` or `'timed-out'`.
   *
   * @example
   * ```ts
   * // On the main thread:
   * const result = await signal.waitAsync(5000);
   * ```
   */
  waitAsync(timeout?: number): Promise<'ok' | 'timed-out'>;

  /**
   * Store the signaled flag and wake up to `count` waiting threads.
   *
   * Atomically stores {@link STATE_SIGNALED} before calling
   * `Atomics.notify`, so threads that call {@link peek} before waiting
   * will also see the notification.
   *
   * @param count Maximum threads to wake (default: 1).
   * @returns Number of threads actually woken (may be 0 if none are waiting).
   *
   * @example
   * ```ts
   * signal.notify(); // wake one waiting thread
   * signal.notify(Infinity); // wake all
   * ```
   */
  notify(count?: number): number;

  /**
   * Non-blocking check. Returns `true` if currently signaled.
   *
   * @example
   * ```ts
   * if (signal.peek()) {
   *   signal.reset();
   *   processWork();
   * }
   * ```
   */
  peek(): boolean;

  /**
   * Reset the signal to idle (0).
   *
   * Should be called by the consumer after handling the notification so
   * that subsequent waits block correctly.
   */
  reset(): void;

  /** The underlying 4-byte SharedArrayBuffer. Pass this to the worker. */
  readonly buffer: SharedArrayBuffer;

  /**
   * Dispose implementation — calls {@link reset} to return to idle state.
   * Enables `using signal = createAtomicSignal()`.
   */
  [Symbol.dispose](): void;
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

function makeAtomicSignal(sab: SharedArrayBuffer): AtomicSignal {
  const i32 = new Int32Array(sab);

  return {
    get buffer() {
      return sab;
    },

    wait(timeout?: number): 'ok' | 'timed-out' {
      const ms = timeout === undefined || timeout === Infinity ? Infinity : timeout;
      // If already signaled, consume and return immediately.
      if (Atomics.compareExchange(i32, SIGNAL_INDEX, STATE_SIGNALED, STATE_IDLE) === STATE_SIGNALED) {
        return 'ok';
      }
      const result = Atomics.wait(i32, SIGNAL_INDEX, STATE_IDLE, ms);
      // Consume the signal flag regardless of how we woke.
      Atomics.store(i32, SIGNAL_INDEX, STATE_IDLE);
      return result === 'timed-out' ? 'timed-out' : 'ok';
    },

    waitAsync(timeout?: number): Promise<'ok' | 'timed-out'> {
      const ms = timeout === undefined || timeout === Infinity ? Infinity : timeout;
      // If already signaled, resolve immediately without allocating a Promise chain.
      if (Atomics.compareExchange(i32, SIGNAL_INDEX, STATE_SIGNALED, STATE_IDLE) === STATE_SIGNALED) {
        return Promise.resolve('ok');
      }
      const { async, value } = Atomics.waitAsync(i32, SIGNAL_INDEX, STATE_IDLE, ms);
      if (!async) {
        // Synchronously resolved (value is the raw result string).
        Atomics.store(i32, SIGNAL_INDEX, STATE_IDLE);
        return Promise.resolve(value === 'timed-out' ? 'timed-out' : 'ok');
      }
      return (value as Promise<'ok' | 'not-equal' | 'timed-out'>).then((result) => {
        Atomics.store(i32, SIGNAL_INDEX, STATE_IDLE);
        return result === 'timed-out' ? 'timed-out' : 'ok';
      });
    },

    notify(count = 1): number {
      Atomics.store(i32, SIGNAL_INDEX, STATE_SIGNALED);
      return Atomics.notify(i32, SIGNAL_INDEX, count === Infinity ? undefined : count);
    },

    peek(): boolean {
      return Atomics.load(i32, SIGNAL_INDEX) === STATE_SIGNALED;
    },

    reset(): void {
      Atomics.store(i32, SIGNAL_INDEX, STATE_IDLE);
    },

    [Symbol.dispose](): void {
      this.reset();
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory functions
// ---------------------------------------------------------------------------

/**
 * Create a new {@link AtomicSignal} backed by a fresh 4-byte
 * {@link SharedArrayBuffer}. This is the **producer** side.
 *
 * Pass `signal.buffer` to the worker, then reconstruct there with
 * {@link atomicSignalFromBuffer}.
 *
 * @example
 * ```ts
 * const signal = createAtomicSignal();
 * worker.postMessage({ signalBuffer: signal.buffer });
 *
 * await signal.waitAsync(5000); // wait for worker to respond
 * ```
 */
export function createAtomicSignal(): AtomicSignal {
  const sab = new SharedArrayBuffer(SIGNAL_BUFFER_BYTES);
  return makeAtomicSignal(sab);
}

/**
 * Wrap an existing {@link SharedArrayBuffer} as an {@link AtomicSignal}.
 *
 * Use this on the **consumer / worker** side after receiving the buffer via
 * `postMessage`.
 *
 * @param buffer A 4-byte `SharedArrayBuffer` previously created by
 *   {@link createAtomicSignal}.
 *
 * @example
 * ```ts
 * // Inside a Bun worker:
 * self.onmessage = ({ data }) => {
 *   const signal = atomicSignalFromBuffer(data.signalBuffer);
 *   // ... do work ...
 *   signal.notify();
 * };
 * ```
 *
 * @throws {RangeError} If the buffer is not exactly {@link SIGNAL_BUFFER_BYTES} bytes.
 */
export function atomicSignalFromBuffer(buffer: SharedArrayBuffer): AtomicSignal {
  if (buffer.byteLength !== SIGNAL_BUFFER_BYTES) {
    throw new RangeError(
      `scatter: atomicSignalFromBuffer expects a ${SIGNAL_BUFFER_BYTES}-byte SharedArrayBuffer, ` +
      `got ${buffer.byteLength} bytes.`,
    );
  }
  return makeAtomicSignal(buffer);
}
