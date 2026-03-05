/**
 * Scatter — Runtime assembly.
 *
 * Wires together all runtime implementations into the public `scatter`
 * function with `.spawn`, `.pool`, and `.max` namespace methods, plus
 * the `Channel` factory helper.
 */

import type { ScatterOptions, SpawnOptions, PoolOptions, MaxBatchOptions, MaxSplitOptions, ThreadHandle, ThreadPool, MaxResult } from '../scatter.js';
import type { ThreadContext, SpawnContext, PoolWorkerContext, MaxWorkerContext } from '../context.js';
import type { ChannelDefinitions } from '../memory/shared-channel.js';
import { scatterOneshot } from './scatter-oneshot.js';
import { scatterSpawn } from './scatter-spawn.js';
import { scatterPool } from './scatter-pool.js';
import { scatterMax } from './scatter-max.js';
import { Channel as ChannelFactory } from './channel-factory.js';

// ---------------------------------------------------------------------------
// Build the scatter function with namespace methods
// ---------------------------------------------------------------------------

/**
 * Run a function on a separate thread and return its result.
 *
 * Also provides `.spawn()`, `.pool()`, and `.max()` for other concurrency
 * patterns.
 */
function scatter<R>(
  fn: (ctx: ThreadContext) => R | Promise<R>,
  options?: ScatterOptions,
): Promise<R> {
  return scatterOneshot(fn, options);
}

/**
 * Spawn a long-lived worker with named, direction-typed shared-memory channels.
 */
scatter.spawn = function spawn<T extends ChannelDefinitions>(
  fn: (ctx: SpawnContext<T>) => void | Promise<void>,
  options: SpawnOptions<T>,
): ThreadHandle<T> {
  return scatterSpawn(fn, options);
};

/**
 * Create a pool of N workers that process tasks in parallel.
 */
scatter.pool = function pool<TIn, TOut>(
  fn: (ctx: PoolWorkerContext, input: TIn) => TOut | Promise<TOut>,
  options?: PoolOptions,
): ThreadPool<TIn, TOut> {
  return scatterPool(fn, options);
};

/**
 * Distribute work across all available CPU cores.
 */
scatter.max = function max<TIn, TOut>(
  fn: (ctx: MaxWorkerContext, input: TIn) => TOut | Promise<TOut>,
  options: MaxBatchOptions<TIn> | MaxSplitOptions<TIn>,
): MaxResult<TOut> {
  return scatterMax(fn, options);
} as {
  <TIn, TOut>(
    fn: (ctx: MaxWorkerContext, input: TIn) => TOut | Promise<TOut>,
    options: MaxBatchOptions<TIn>,
  ): MaxResult<TOut>;
  <TIn, TOut>(
    fn: (ctx: MaxWorkerContext, chunk: TIn) => TOut | Promise<TOut>,
    options: MaxSplitOptions<TIn>,
  ): MaxResult<TOut>;
};

export { scatter };
export { ChannelFactory as Channel };
