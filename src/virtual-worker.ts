/**
 * Scatter — VirtualWorker factory.
 *
 * Materializes a user function into a running Bun Worker without writing any
 * file to disk. Pipeline:
 *
 *   Function → .toString() → generateScaffold() → Blob → URL.createObjectURL → new Worker(url)
 *
 * Lifecycle:
 *   1. materialize() generates scaffold source and creates the Worker
 *   2. Caller awaits vw.ready — resolves when the worker posts __SCATTER_INIT_ACK__
 *   3. Caller sends tasks / reads results via the worker directly
 *   4. vw.shutdown() requests graceful teardown; vw.dispose() force-terminates
 *
 * Error handling:
 *   - worker.onerror   → rejects vw.ready, calls registered onError handlers
 *   - worker close/exit → calls registered onExit handlers; rejects vw.ready if pending
 *   - AbortSignal abort → calls dispose() synchronously
 *   - timeout          → calls dispose(), rejects vw.ready
 *
 * This is an internal module. Users interact via scatter() / scatter.spawn() / scatter.pool().
 */

import type { ChannelMeta } from './memory/shared-channel.js';
import type { ScaffoldMode } from './protocol.js';
import { generateScaffold } from './scaffold.js';
import {
  ThreadAbortError,
  MaterializationError,
  WorkerCrashedError,
} from './error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for materializing a virtual worker. */
export interface MaterializeOptions {
  /** Bare module specifiers injected as import statements in the worker. */
  readonly imports?: readonly string[];

  /** Serializable data sent to the worker in the init message. */
  readonly data?: Readonly<Record<string, unknown>>;

  /**
   * Named channel metadata. Each entry contains the SharedArrayBuffers and
   * codec name needed to reconstruct a SharedChannel inside the worker.
   */
  readonly channelMeta?: Readonly<Record<string, ChannelMeta>>;

  /** AbortSignal for external cancellation. Disposes the worker when aborted. */
  readonly signal?: AbortSignal;

  /** Timeout in milliseconds. Worker is force-terminated on expiry. */
  readonly timeout?: number;

  /** Scaffold mode — selects the execution loop inside the worker. */
  readonly mode: ScaffoldMode;

  /**
   * Maximum number of tasks processed concurrently per worker.
   * Only meaningful for `pool` and `max` modes. Default: `1`.
   */
  readonly concurrency?: number;
}

/**
 * A materialized virtual worker.
 *
 * Implements both `Disposable` and `AsyncDisposable` for use with `using` /
 * `await using` declarations. Wraps the underlying Bun Worker with full
 * lifecycle management: init handshake, blob URL cleanup, abort/timeout
 * wiring, graceful shutdown, and crash detection.
 */
export interface VirtualWorker extends Disposable, AsyncDisposable {
  /** The underlying Bun Worker instance. */
  readonly worker: Worker;

  /** The blob URL created for this worker (used for cleanup). */
  readonly blobUrl: string;

  /** Unique thread ID assigned to this worker. */
  readonly threadId: number;

  /**
   * Resolves when the worker posts `__SCATTER_INIT_ACK__`, confirming it has
   * hydrated all shared-memory channels and is ready to accept work.
   * Rejects on error, crash, or timeout.
   */
  readonly ready: Promise<void>;

  /**
   * Request graceful shutdown. Posts `__SCATTER_SHUTDOWN__` to the worker,
   * races against an optional timeout, and then calls `dispose()` regardless.
   *
   * @param timeout Maximum milliseconds to wait for ack. Default: `5000`.
   */
  shutdown(timeout?: number): Promise<void>;

  /**
   * Force-terminate the worker, revoke the blob URL, and clean up all
   * resources. Safe to call multiple times (idempotent).
   */
  dispose(): void;

  /**
   * Register a handler for unexpected worker errors (e.g. parse failures,
   * OOM). May be called multiple times to add additional handlers.
   */
  onError(handler: (error: Error) => void): void;

  /**
   * Register a handler for worker exit. The `code` argument is the process
   * exit code reported by Bun, or `0` if unavailable.
   */
  onExit(handler: (code: number) => void): void;

  /** Whether `dispose()` has been called on this worker. */
  readonly disposed: boolean;

  /** Synchronous dispose — same as `dispose()`. For `using` declarations. */
  [Symbol.dispose](): void;

  /** Async dispose — awaits `shutdown()` then calls `dispose()`. For `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

// ---------------------------------------------------------------------------
// Thread-ID counter
// ---------------------------------------------------------------------------

let __nextThreadId = 1;

function nextThreadId(): number {
  return __nextThreadId++;
}

// ---------------------------------------------------------------------------
// materialize()
// ---------------------------------------------------------------------------

/**
 * Materialize a user function into a running Bun Worker.
 *
 * Creates the scaffold source, wraps it in a Blob, and boots a Worker from
 * the resulting object URL. The returned `VirtualWorker` object exposes the
 * worker, lifecycle helpers, and the `ready` promise.
 *
 * @param fn   The user-supplied function to run inside the worker.
 *             Must be serializable via `.toString()`.
 * @param options Materialization options (imports, data, channels, abort, timeout, mode).
 *
 * @throws {ThreadAbortError}     If `options.signal` is already aborted.
 * @throws {MaterializationError} If Blob creation or Worker construction fails.
 *
 * @example
 * ```ts
 * const vw = materialize((ctx) => ctx.data.x * 2, {
 *   mode: 'oneshot',
 *   data: { x: 21 },
 * });
 * await vw.ready;
 * // worker is now running; listen to vw.worker.onmessage for results
 * ```
 */
export function materialize(
  fn: Function, // eslint-disable-line @typescript-eslint/ban-types
  options: MaterializeOptions,
): VirtualWorker {
  const {
    imports = [],
    data = {},
    channelMeta = {},
    signal,
    timeout,
    mode,
    concurrency = 1,
  } = options;

  // -------------------------------------------------------------------------
  // 1. Abort-before-create guard
  // -------------------------------------------------------------------------
  if (signal?.aborted) {
    throw new ThreadAbortError();
  }

  // -------------------------------------------------------------------------
  // 2. Input validation
  // -------------------------------------------------------------------------
  if (typeof fn !== 'function') {
    throw new TypeError(`scatter: materialize() expected a function, got ${typeof fn}`);
  }

  const validModes: ReadonlySet<string> = new Set(['oneshot', 'spawn', 'pool', 'max']);
  if (!validModes.has(mode)) {
    throw new TypeError(`scatter: invalid scaffold mode "${mode}"`);
  }

  // -------------------------------------------------------------------------
  // 3. Build scaffold source
  // -------------------------------------------------------------------------
  let source: string;
  try {
    source = generateScaffold({
      fnSource: fn.toString(),
      imports,
      mode,
      concurrency,
    });
  } catch (err) {
    throw new MaterializationError(
      `scatter: failed to generate scaffold for mode "${mode}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // -------------------------------------------------------------------------
  // 3. Create Blob + object URL
  // -------------------------------------------------------------------------
  let blobUrl: string;
  try {
    const blob = new Blob([source], { type: 'application/javascript' });
    blobUrl = URL.createObjectURL(blob);
  } catch (err) {
    throw new MaterializationError(
      `scatter: failed to create worker blob: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // -------------------------------------------------------------------------
  // 4. Create Worker
  // -------------------------------------------------------------------------
  let worker: Worker;
  try {
    worker = new Worker(blobUrl);
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    throw new MaterializationError(
      `scatter: failed to construct Worker from blob URL: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // -------------------------------------------------------------------------
  // 5. Internal state
  // -------------------------------------------------------------------------
  const threadId = nextThreadId();
  let _disposed = false;
  let _readyResolved = false;

  const _errorHandlers: Array<(error: Error) => void> = [];
  const _exitHandlers: Array<(code: number) => void> = [];

  let _readyResolve!: () => void;
  let _readyReject!: (reason: unknown) => void;
  const _ready = new Promise<void>((resolve, reject) => {
    _readyResolve = resolve;
    _readyReject = reject;
  });

  // Prevent unhandled rejection when dispose() is called before ready resolves.
  // Callers who await vw.ready will still receive the rejection.
  _ready.catch(() => {});

  // -------------------------------------------------------------------------
  // 6. Core dispose logic (force-terminate, idempotent)
  // -------------------------------------------------------------------------
  let _timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let _abortListener: (() => void) | undefined;

  function dispose(): void {
    if (_disposed) return;
    _disposed = true;

    // Clear timeout
    if (_timeoutHandle !== undefined) {
      clearTimeout(_timeoutHandle);
      _timeoutHandle = undefined;
    }

    // Remove abort listener
    if (_abortListener !== undefined && signal !== undefined) {
      signal.removeEventListener('abort', _abortListener);
      _abortListener = undefined;
    }

    // Terminate worker (Bun Worker)
    try {
      worker.terminate();
      // Unref the worker so it doesn't prevent the process from exiting
      if (typeof (worker as any).unref === 'function') {
        (worker as any).unref();
      }
    } catch {}

    // Revoke blob URL
    try { URL.revokeObjectURL(blobUrl); } catch {}
  }

  // -------------------------------------------------------------------------
  // 7. Worker error/exit handlers
  // -------------------------------------------------------------------------
  worker.onerror = (event: ErrorEvent) => {
    const err = new MaterializationError(
      event.message ?? 'Worker error',
      { cause: event.error ?? undefined },
    );

    if (!_readyResolved) {
      _readyResolved = true;
      _readyReject(err);
    }

    for (const h of _errorHandlers) {
      try { h(err); } catch {}
    }

    dispose();
  };

  // Bun Workers emit a 'close' event with exit code on process exit.
  // The Web Worker spec uses MessageEvent for messages; close is Bun-specific.
  (worker as unknown as EventTarget).addEventListener('close', (event: Event) => {
    const code = (event as unknown as { code?: number }).code ?? 0;

    if (!_readyResolved) {
      _readyResolved = true;
      _readyReject(new WorkerCrashedError(code));
    }

    for (const h of _exitHandlers) {
      try { h(code); } catch {}
    }

    dispose();
  });

  // -------------------------------------------------------------------------
  // 8. Ready handshake — listen for __SCATTER_INIT_ACK__
  // -------------------------------------------------------------------------
  const _initAckHandler = (event: MessageEvent) => {
    const msg = event.data as { __type?: string; threadId?: number };
    if (msg.__type === '__SCATTER_INIT_ACK__' && msg.threadId === threadId) {
      worker.removeEventListener('message', _initAckHandler);
      if (!_readyResolved) {
        _readyResolved = true;
        _readyResolve();
      }
    }
  };
  worker.addEventListener('message', _initAckHandler);

  // -------------------------------------------------------------------------
  // 9. Timeout wiring
  // -------------------------------------------------------------------------
  if (timeout !== undefined && timeout > 0) {
    _timeoutHandle = setTimeout(() => {
      if (!_readyResolved) {
        _readyResolved = true;
        _readyReject(
          new MaterializationError(`scatter: worker timed out after ${timeout}ms before posting INIT_ACK`),
        );
      }
      dispose();
    }, timeout);
    // Unref so this timer doesn't prevent the process from exiting
    if (typeof _timeoutHandle === 'object' && 'unref' in _timeoutHandle) {
      (_timeoutHandle as NodeJS.Timeout).unref();
    }
  }

  // -------------------------------------------------------------------------
  // 10. AbortSignal wiring
  // -------------------------------------------------------------------------
  if (signal !== undefined) {
    _abortListener = () => {
      if (!_readyResolved) {
        _readyResolved = true;
        _readyReject(new ThreadAbortError());
      }
      dispose();
    };
    signal.addEventListener('abort', _abortListener, { once: true });
  }

  // -------------------------------------------------------------------------
  // 11. Send __SCATTER_INIT__
  // -------------------------------------------------------------------------
  worker.postMessage({
    __type: '__SCATTER_INIT__',
    threadId,
    mode,
    data,
    channelMeta,
  });

  // -------------------------------------------------------------------------
  // 12. Graceful shutdown
  // -------------------------------------------------------------------------
  async function shutdown(shutdownTimeout = 5_000): Promise<void> {
    if (_disposed) return;

    worker.postMessage({ __type: '__SCATTER_SHUTDOWN__' });

    await Promise.race([
      new Promise<void>((resolve) => {
        const handler = (event: MessageEvent) => {
          const msg = event.data as { __type?: string };
          if (msg.__type === '__SCATTER_SHUTDOWN_ACK__') {
            worker.removeEventListener('message', handler);
            resolve();
          }
        };
        worker.addEventListener('message', handler);
      }),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, shutdownTimeout);
        if (typeof timer === 'object' && 'unref' in timer) {
          (timer as NodeJS.Timeout).unref();
        }
      }),
    ]);

    dispose();
  }

  // -------------------------------------------------------------------------
  // 13. Assemble VirtualWorker
  // -------------------------------------------------------------------------
  const vw: VirtualWorker = {
    worker,
    blobUrl,
    threadId,
    get ready() { return _ready; },
    get disposed() { return _disposed; },

    shutdown,
    dispose,

    onError(handler) {
      _errorHandlers.push(handler);
    },
    onExit(handler) {
      _exitHandlers.push(handler);
    },

    [Symbol.dispose]() {
      dispose();
    },

    async [Symbol.asyncDispose]() {
      await shutdown();
    },
  };

  return vw;
}
