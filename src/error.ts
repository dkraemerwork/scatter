/**
 * Scatter — Error hierarchy.
 *
 * Real class implementations (not `declare class`) so that `instanceof` checks
 * work correctly for callers. Every class carries a `_tag` discriminant for
 * structural matching without `instanceof` (e.g. Effect integration).
 *
 * Serialization helpers (`serializeError` / `reconstructError`) are used by
 * the scaffold and virtual-worker to ship errors across the postMessage boundary.
 */

// ---------------------------------------------------------------------------
// Serialization wire format (internal)
// ---------------------------------------------------------------------------

/**
 * JSON-safe snapshot of an Error, transmitted via `postMessage` from worker → main.
 *
 * @internal Not part of the public API surface. Subject to change.
 */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack: string;
  readonly cause?: SerializedError;
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

/**
 * Base class for every error thrown by scatter.
 *
 * The `name` property is frozen after construction to prevent prototype
 * pollution — a subclass cannot accidentally expose a mutable `name` via
 * an inherited setter.
 */
export class ScatterError extends Error {
  override readonly name: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    Object.defineProperty(this, 'name', { value: this.name, writable: false, configurable: true });
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

// ---------------------------------------------------------------------------
// Thread / worker lifecycle errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the user-supplied worker function itself throws.
 *
 * The original error is serialized inside the worker and reconstructed on the
 * calling thread so that the full remote stack trace is preserved.
 *
 * Thrown by: `scatter()`, `thread()`, any awaited worker invocation.
 */
export class ThreadExecutionError extends ScatterError {
  override readonly name = 'ThreadExecutionError' as const;
  readonly _tag = 'ThreadExecutionError' as const;

  /** The `name` of the original error thrown inside the worker. */
  readonly originalName: string;

  /** The full stack trace of the original error from inside the worker. */
  readonly originalStack: string;

  constructor(
    message: string,
    originalName: string,
    originalStack: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.originalName = originalName;
    this.originalStack = originalStack;
  }
}

/**
 * Thrown when a worker invocation exceeds the configured `timeout` milliseconds
 * and is forcibly terminated.
 *
 * Thrown by: `scatter()`, `thread()` when `options.timeout` is set.
 */
export class ThreadTimeoutError extends ScatterError {
  override readonly name = 'ThreadTimeoutError' as const;
  readonly _tag = 'ThreadTimeoutError' as const;

  /** The timeout value in milliseconds that was exceeded. */
  readonly timeout: number;

  constructor(timeout: number, options?: ErrorOptions) {
    super(`Worker exceeded timeout of ${timeout}ms`, options);
    this.timeout = timeout;
  }
}

/**
 * Thrown when a worker invocation is cancelled because the caller's
 * `AbortSignal` was aborted before the worker finished.
 *
 * Thrown by: `scatter()`, `thread()` when `options.signal` is aborted.
 */
export class ThreadAbortError extends ScatterError {
  override readonly name = 'ThreadAbortError' as const;
  readonly _tag = 'ThreadAbortError' as const;

  constructor(options?: ErrorOptions) {
    super('Worker was aborted', options);
  }
}

/**
 * Thrown when a worker process exits unexpectedly with no error message posted
 * back — e.g. OOM kill, segfault, or uncaught native crash. The pending
 * caller promise is rejected with this error so it never hangs.
 *
 * Thrown by: the internal worker exit handler when exit code is non-zero and
 * no `ThreadExecutionError` has already been dispatched for that invocation.
 */
export class WorkerCrashedError extends ScatterError {
  override readonly name = 'WorkerCrashedError' as const;
  readonly _tag = 'WorkerCrashedError' as const;

  /** The process exit code reported by Bun, or `null` if unavailable. */
  readonly exitCode: number | null;

  constructor(exitCode: number | null, options?: ErrorOptions) {
    const code = exitCode !== null ? ` (exit code ${exitCode})` : '';
    super(`Worker exited unexpectedly${code}`, options);
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Materialization error
// ---------------------------------------------------------------------------

/**
 * Thrown when scatter fails to construct the inline worker — e.g. `Blob`
 * creation fails, the object URL cannot be registered, or `new Worker()`
 * itself throws before the worker script starts executing.
 *
 * Thrown by: the internal `materialize()` helper during worker setup.
 */
export class MaterializationError extends ScatterError {
  override readonly name = 'MaterializationError' as const;
  readonly _tag = 'MaterializationError' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// Channel errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a caller attempts to write to or read from a channel that has
 * already been closed via `channel.close()`.
 *
 * Thrown by: `Channel.write()`, `Channel.writeBlocking()`, `Channel.read()`,
 * `Channel.readBlocking()`.
 */
export class ChannelClosedError extends ScatterError {
  override readonly name = 'ChannelClosedError' as const;
  readonly _tag = 'ChannelClosedError' as const;

  constructor(options?: ErrorOptions) {
    super('Channel is closed', options);
  }
}

/**
 * Thrown by `Channel.writeBlocking()` when the channel's ring buffer remains
 * full for longer than the caller-supplied timeout and the write cannot
 * complete. The message was NOT written; the caller should decide whether to
 * retry, drop, or propagate.
 *
 * Thrown by: `Channel.writeBlocking()` when `timeout` expires with the buffer
 * still at capacity.
 */
export class ChannelFullError extends ScatterError {
  override readonly name = 'ChannelFullError' as const;
  readonly _tag = 'ChannelFullError' as const;

  /** The timeout in milliseconds that elapsed while waiting for space. */
  readonly timeout: number;

  constructor(timeout: number, options?: ErrorOptions) {
    super(`Channel remained full after ${timeout}ms`, options);
    this.timeout = timeout;
  }
}

/**
 * Thrown when a task is submitted to a pool that has already been terminated
 * or is shutting down, or when pending tasks are rejected due to pool
 * termination.
 *
 * Thrown by: `pool.exec()` when the pool is terminated, and during
 * `pool.terminate()` for all pending tasks.
 */
export class PoolTerminatedError extends ScatterError {
  override readonly name = 'PoolTerminatedError' as const;
  readonly _tag = 'PoolTerminatedError' as const;

  constructor(options?: ErrorOptions) {
    super('Pool has been terminated', options);
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Converts any thrown value into a `SerializedError` suitable for
 * `postMessage` transmission across a worker boundary.
 *
 * Non-Error values are wrapped with a generic message so the cause chain is
 * never lost. The function recurses into `error.cause` up to a reasonable
 * depth to capture the full chain.
 *
 * Used by: the virtual-worker entry point to serialize unhandled rejections
 * before posting them back to the scaffold.
 */
export function serializeError(error: unknown, _depth = 0): SerializedError {
  const MAX_DEPTH = 10;

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? `${error.name}: ${error.message}`,
      cause: error.cause !== undefined && _depth < MAX_DEPTH
        ? serializeError(error.cause, _depth + 1)
        : undefined,
    };
  }

  const message = typeof error === 'string'
    ? error
    : (() => {
        try {
          return JSON.stringify(error);
        } catch {
          return String(error);
        }
      })();

  return {
    name: 'UnknownError',
    message,
    stack: `UnknownError: ${message}`,
  };
}

/**
 * Rebuilds a `ThreadExecutionError` from a `SerializedError` received via
 * `postMessage`. The original error name and stack are preserved as fields so
 * the caller can inspect the remote failure without losing fidelity.
 *
 * Used by: the scaffold's message handler when it receives a serialized worker
 * error and needs to reject the caller's promise with a rich error object.
 */
export function reconstructError(serialized: SerializedError): ThreadExecutionError {
  const cause = serialized.cause !== undefined
    ? reconstructError(serialized.cause)
    : undefined;

  return new ThreadExecutionError(
    serialized.message,
    serialized.name,
    serialized.stack,
    cause !== undefined ? { cause } : undefined,
  );
}
