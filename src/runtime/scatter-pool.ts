/**
 * Scatter — Pool runtime implementation.
 *
 * `scatter.pool(fn, options?)` creates a pool of N workers that process
 * tasks in parallel. Workers are pre-spawned and reused. Tasks are dispatched
 * via postMessage according to the configured strategy.
 */

import type { PoolOptions, ThreadPool, PoolStats, ExecOptions } from '../scatter.js';
import type { PoolWorkerContext } from '../context.js';
import type { VirtualWorker } from '../virtual-worker.js';
import { materialize } from '../virtual-worker.js';
import { reconstructError, WorkerCrashedError } from '../error.js';
import { ScatterMessageType } from '../protocol.js';
import { PoolTerminatedError } from '../error.js';

interface PoolWorkerState {
  vw: VirtualWorker;
  activeTasks: number;
  alive: boolean;
}

interface PendingTask<TOut> {
  resolve: (value: TOut) => void;
  reject: (error: Error) => void;
  workerIdx: number;
}

/**
 * Create a pool of N workers that process tasks in parallel.
 */
export function scatterPool<TIn, TOut>(
  fn: (ctx: PoolWorkerContext, input: TIn) => TOut | Promise<TOut>,
  options?: PoolOptions,
): ThreadPool<TIn, TOut> {
  if (typeof fn !== 'function') {
    throw new TypeError(`scatter.pool: expected a function, got ${typeof fn}`);
  }

  const size = options?.size ?? (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) ?? 4;
  const strategy = options?.strategy ?? 'round-robin';
  const maxQueue = options?.maxQueue ?? Infinity;
  const concurrency = options?.concurrency ?? 1;

  if (typeof size !== 'number' || size < 1 || !Number.isInteger(size)) {
    throw new TypeError(`scatter.pool: size must be a positive integer, got ${size}`);
  }

  if (typeof concurrency !== 'number' || concurrency < 1 || !Number.isInteger(concurrency)) {
    throw new TypeError(`scatter.pool: concurrency must be a positive integer, got ${concurrency}`);
  }

  const workers: PoolWorkerState[] = [];
  const pending = new Map<number, PendingTask<TOut>>();
  let nextTaskId = 1;
  let roundRobinIdx = 0;
  let completedTasks = 0;
  let terminated = false;
  let shuttingDown = false;

  // Backpressure waiters
  const queueWaiters: Array<() => void> = [];

  // Drain waiters
  const drainWaiters: Array<() => void> = [];

  function checkDrain(): void {
    if (pending.size === 0 && drainWaiters.length > 0) {
      for (const waiter of drainWaiters.splice(0)) {
        waiter();
      }
    }
  }

  function checkQueueSpace(): void {
    if (pending.size < maxQueue && queueWaiters.length > 0) {
      const waiter = queueWaiters.shift();
      if (waiter) waiter();
    }
  }

  // Spawn workers
  for (let i = 0; i < size; i++) {
    const vw = materialize(fn as Function, {
      mode: 'pool',
      imports: options?.imports ? [...options.imports] : [],
      data: {
        ...(options?.data ?? {}),
        __workerIndex: i,
      },
      concurrency,
    });

    const workerState: PoolWorkerState = { vw, activeTasks: 0, alive: true };

    vw.worker.addEventListener('message', ({ data: msg }) => {
      if (msg.__type === ScatterMessageType.TASK_RESULT) {
        const entry = pending.get(msg.taskId);
        if (entry) {
          pending.delete(msg.taskId);
          workers[entry.workerIdx].activeTasks--;
          completedTasks++;
          entry.resolve(msg.value as TOut);
          checkDrain();
          checkQueueSpace();
        }
      } else if (msg.__type === ScatterMessageType.TASK_ERROR) {
        const entry = pending.get(msg.taskId);
        if (entry) {
          pending.delete(msg.taskId);
          workers[entry.workerIdx].activeTasks--;
          completedTasks++;
          entry.reject(reconstructError(msg.error));
          checkDrain();
          checkQueueSpace();
        }
      }
    });

    // Handle worker crash
    vw.onError(() => {
      workerState.alive = false;
      // Reject all in-flight tasks for this worker
      for (const [taskId, entry] of pending) {
        if (entry.workerIdx === i) {
          pending.delete(taskId);
          entry.reject(new WorkerCrashedError(null));
          completedTasks++;
        }
      }
      checkDrain();
      checkQueueSpace();
    });

    vw.onExit(() => {
      workerState.alive = false;
    });

    workers.push(workerState);
  }

  function pickWorker(): number {
    if (strategy === 'round-robin') {
      // Find next alive worker starting from current index
      for (let attempt = 0; attempt < size; attempt++) {
        const idx = (roundRobinIdx + attempt) % size;
        if (workers[idx].alive) {
          roundRobinIdx = (idx + 1) % size;
          return idx;
        }
      }
      return -1; // No alive workers
    }

    // least-busy
    let minIdx = -1;
    let minTasks = Infinity;
    for (let i = 0; i < workers.length; i++) {
      if (workers[i].alive && workers[i].activeTasks < minTasks) {
        minTasks = workers[i].activeTasks;
        minIdx = i;
      }
    }
    return minIdx;
  }

  const pool: ThreadPool<TIn, TOut> = {
    async exec(input: TIn, execOptions?: ExecOptions): Promise<TOut> {
      if (terminated || shuttingDown) {
        throw new PoolTerminatedError();
      }

      // Backpressure: wait if queue is full
      if (maxQueue !== Infinity && pending.size >= maxQueue) {
        await new Promise<void>((resolve) => {
          queueWaiters.push(resolve);
        });
        // Re-check after waking
        if (terminated || shuttingDown) {
          throw new PoolTerminatedError();
        }
      }

      const workerIdx = pickWorker();
      if (workerIdx === -1) {
        throw new WorkerCrashedError(null);
      }

      const taskId = nextTaskId++;
      const workerState = workers[workerIdx];
      workerState.activeTasks++;

      return new Promise<TOut>((resolve, reject) => {
        pending.set(taskId, { resolve, reject, workerIdx });

        // Per-task abort
        if (execOptions?.signal) {
          const taskSignal = execOptions.signal;
          if (taskSignal.aborted) {
            pending.delete(taskId);
            workerState.activeTasks--;
            reject(taskSignal.reason ?? new Error('Task aborted'));
            return;
          }
          taskSignal.addEventListener('abort', () => {
            const entry = pending.get(taskId);
            if (entry) {
              pending.delete(taskId);
              workerState.activeTasks--;
              completedTasks++;
              reject(taskSignal.reason ?? new Error('Task aborted'));
              checkDrain();
              checkQueueSpace();
            }
          }, { once: true });
        }

        workerState.vw.worker.postMessage({
          __type: ScatterMessageType.TASK,
          taskId,
          input,
        });
      });
    },

    async *execMany(inputs: Iterable<TIn>): AsyncGenerator<TOut> {
      const results: Array<Promise<TOut>> = [];
      for (const input of inputs) {
        results.push(pool.exec(input));
      }
      // Yield in completion order using Promise.race pattern
      const remaining = new Set(results.map((p, i) => ({ promise: p, index: i })));
      while (remaining.size > 0) {
        const entries = [...remaining];
        const { value, index } = await Promise.race(
          entries.map(async (entry) => {
            const value = await entry.promise;
            return { value, index: entry.index };
          }),
        );
        // Find and remove the resolved entry
        for (const entry of remaining) {
          if (entry.index === index) {
            remaining.delete(entry);
            break;
          }
        }
        yield value;
      }
    },

    async drain(): Promise<void> {
      if (pending.size === 0) return;
      return new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },

    terminate(): void {
      if (terminated) return;
      terminated = true;

      // Reject all pending tasks
      for (const [taskId, entry] of pending) {
        pending.delete(taskId);
        entry.reject(new PoolTerminatedError());
      }

      // Release backpressure waiters
      for (const waiter of queueWaiters.splice(0)) {
        waiter();
      }

      // Release drain waiters
      for (const waiter of drainWaiters.splice(0)) {
        waiter();
      }

      // Dispose all workers
      for (const worker of workers) {
        if (worker.alive) {
          worker.alive = false;
          try { worker.vw.dispose(); } catch {}
        }
      }
    },

    async shutdown(): Promise<void> {
      if (terminated) return;
      shuttingDown = true;

      // Wait for in-flight tasks
      await pool.drain();

      // Graceful shutdown each worker
      const shutdownPromises = workers
        .filter((w) => w.alive)
        .map(async (w) => {
          try { await w.vw.shutdown(); } catch {}
          w.alive = false;
        });
      await Promise.all(shutdownPromises);

      terminated = true;
    },

    get stats(): PoolStats {
      let activeWorkers = 0;
      let workersAlive = 0;
      for (const w of workers) {
        if (w.alive) workersAlive++;
        if (w.activeTasks > 0 && w.alive) activeWorkers++;
      }
      return {
        activeWorkers,
        pendingTasks: pending.size,
        completedTasks,
        workersAlive,
      };
    },

    [Symbol.dispose](): void {
      pool.terminate();
    },

    async [Symbol.asyncDispose](): Promise<void> {
      await pool.shutdown();
    },
  };

  return pool;
}
