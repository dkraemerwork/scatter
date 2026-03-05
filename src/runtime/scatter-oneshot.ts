/**
 * Scatter — One-shot runtime implementation.
 *
 * `scatter(fn, options?)` materializes a worker, executes the function once,
 * returns the result, and cleans up. No files, no boilerplate.
 *
 * Error handling:
 *   - Worker function throws -> `ThreadExecutionError`
 *   - Timeout exceeded -> `ThreadTimeoutError`
 *   - AbortSignal fired -> `ThreadAbortError`
 *   - Worker crash -> `WorkerCrashedError`
 */

import type { ScatterOptions } from '../scatter.js';
import type { ThreadContext } from '../context.js';
import { materialize } from '../virtual-worker.js';
import {
  reconstructError,
  ThreadTimeoutError,
  ThreadAbortError,
} from '../error.js';
import { ScatterMessageType } from '../protocol.js';

/**
 * Run a function on a separate thread and return its result.
 *
 * The worker is created, executes the function, returns the value, and is
 * destroyed — all automatically.
 */
export function scatterOneshot<R>(
  fn: (ctx: ThreadContext) => R | Promise<R>,
  options?: ScatterOptions,
): Promise<R> {
  if (typeof fn !== 'function') {
    return Promise.reject(
      new TypeError(`scatter: expected a function, got ${typeof fn}`),
    );
  }

  const timeout = options?.timeout;
  const signal = options?.signal;

  // Pre-check abort before any work.
  if (signal?.aborted) {
    return Promise.reject(new ThreadAbortError());
  }

  let vw: ReturnType<typeof materialize>;
  try {
    vw = materialize(fn as Function, {
      mode: 'oneshot',
      imports: options?.imports ? [...options.imports] : [],
      data: options?.data ? { ...options.data } : {},
      signal,
    });
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise<R>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortCleanup: (() => void) | undefined;

    function settle(action: () => void): void {
      if (settled) return;
      settled = true;

      // Clean up timers and listeners immediately
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (abortCleanup) {
        abortCleanup();
        abortCleanup = undefined;
      }

      action();
    }

    // ----- Result / error from worker function -----
    vw.worker.addEventListener('message', ({ data: msg }) => {
      if (msg.__type === ScatterMessageType.RESULT) {
        settle(() => {
          resolve(msg.value as R);
          vw.dispose();
        });
      } else if (msg.__type === ScatterMessageType.ERROR) {
        settle(() => {
          reject(reconstructError(msg.error));
          vw.dispose();
        });
      }
    });

    // ----- Worker crashed -----
    vw.onError((err) => {
      settle(() => reject(err));
    });

    // ----- Ready failure (timeout during init, abort during init, crash) -----
    vw.ready.catch((err) => {
      settle(() => reject(err));
    });

    // ----- Result-level timeout (covers execution, not just init) -----
    if (timeout !== undefined && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        settle(() => {
          reject(new ThreadTimeoutError(timeout));
          vw.dispose();
        });
      }, timeout);
      // Unref the timer so it doesn't keep the event loop alive
      if (typeof timeoutHandle === 'object' && 'unref' in timeoutHandle) {
        (timeoutHandle as NodeJS.Timeout).unref();
      }
    }

    // ----- Post-ready abort wiring -----
    if (signal !== undefined) {
      const abortHandler = (): void => {
        settle(() => {
          reject(new ThreadAbortError());
          vw.dispose();
        });
      };
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener('abort', abortHandler, { once: true });
        abortCleanup = () => {
          signal.removeEventListener('abort', abortHandler);
        };
      }
    }
  });
}
