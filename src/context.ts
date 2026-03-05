/**
 * Scatter — ThreadContext contract.
 *
 * These are the context objects injected into user functions running inside
 * scatter workers. Each API tier provides its own context shape:
 *
 *   scatter()        → {@link ThreadContext}
 *   scatter.spawn()  → {@link SpawnContext}
 *   scatter.pool()   → {@link PoolWorkerContext}
 *   scatter.max()    → {@link MaxWorkerContext}
 */

import type {
  ChannelDefinitions,
  InferChannelType,
  ReadableChannel,
  WritableChannel,
} from './memory/shared-channel.js';

// ---------------------------------------------------------------------------
// Base context — available in all scatter workers
// ---------------------------------------------------------------------------

/**
 * Context passed to every scatter worker function.
 *
 * This is the base shape that all worker contexts extend. It provides the
 * immutable data payload and a stable identity for the thread.
 *
 * @example
 * ```ts
 * const result = await scatter((ctx: ThreadContext) => {
 *   const { iterations } = ctx.data as { iterations: number };
 *   let sum = 0;
 *   for (let i = 0; i < iterations; i++) sum += i;
 *   return sum;
 * }, { data: { iterations: 1_000_000 } });
 * ```
 */
export interface ThreadContext {
  /**
   * Serializable data passed from the calling thread via `options.data`.
   * Transmitted via structured clone during worker initialization.
   * Always a non-null object; defaults to `{}` when not provided.
   */
  readonly data: Readonly<Record<string, unknown>>;

  /**
   * Unique numeric identifier for this worker thread.
   * Stable for the lifetime of the worker; not reused after termination.
   */
  readonly threadId: number;
}

// ---------------------------------------------------------------------------
// Direction-aware channel access for spawn workers
// ---------------------------------------------------------------------------

/**
 * Resolves the correct channel interface for a worker accessing a named channel.
 *
 * The direction is encoded in the channel definition:
 * - `'in'`  — main thread writes, **worker reads** → `ReadableChannel<T>`
 * - `'out'` — **worker writes**, main thread reads → `WritableChannel<T>`
 * - unknown  — union of both (escape hatch for runtime-defined channels)
 *
 * This type is used internally by {@link SpawnContext.channel} to give callers
 * the narrowest correct interface at the point of use.
 *
 * @typeParam T  The full channel definitions map from `scatter.spawn()`.
 * @typeParam K  The specific channel name being accessed.
 *
 * @example
 * ```ts
 * // tasks is Channel.in<Task>()  → direction: 'in'
 * // Worker receives ReadableChannel<Task>
 * const tasks: WorkerSideChannel<Channels, 'tasks'> = ctx.channel('tasks');
 * const task = tasks.readBlocking();
 *
 * // results is Channel.out<Result>()  → direction: 'out'
 * // Worker receives WritableChannel<Result>
 * const results: WorkerSideChannel<Channels, 'results'> = ctx.channel('results');
 * results.write({ id: task!.id, value: task!.value * 2 });
 * ```
 */
export type WorkerSideChannel<
  T extends ChannelDefinitions,
  K extends string & keyof T,
> = T[K] extends { direction: 'in' }
  ? ReadableChannel<InferChannelType<T[K]>>
  : T[K] extends { direction: 'out' }
    ? WritableChannel<InferChannelType<T[K]>>
    : ReadableChannel<InferChannelType<T[K]>> | WritableChannel<InferChannelType<T[K]>>;

// ---------------------------------------------------------------------------
// Spawn context — persistent workers with named channels
// ---------------------------------------------------------------------------

/**
 * Extended context for `scatter.spawn()` workers. Adds direction-aware channel access.
 *
 * Channel direction is encoded in the definition and enforced at the type level:
 * - `Channel.in<T>()` channels → worker gets `ReadableChannel<T>`
 * - `Channel.out<T>()` channels → worker gets `WritableChannel<T>`
 *
 * @typeParam T  The channel definitions map passed to `scatter.spawn()`.
 *
 * @example
 * ```ts
 * type Channels = {
 *   tasks:   ReturnType<typeof Channel.in<Task>>;
 *   results: ReturnType<typeof Channel.out<Result>>;
 * };
 *
 * scatter.spawn((ctx: SpawnContext<Channels>) => {
 *   const tasks   = ctx.channel('tasks');   // ReadableChannel<Task>
 *   const results = ctx.channel('results'); // WritableChannel<Result>
 *
 *   for await (const task of tasks) {
 *     results.write({ id: task.id, value: task.value * 2 });
 *   }
 *   results.close();
 * }, { channels: { tasks: Channel.in<Task>(), results: Channel.out<Result>() } });
 * ```
 */
export interface SpawnContext<T extends ChannelDefinitions = ChannelDefinitions>
  extends ThreadContext {
  /**
   * Access a named shared-memory channel.
   *
   * The channel is hydrated from the SharedArrayBuffers passed during worker
   * initialization. The returned interface is narrowed by direction:
   * - `'in'` channels (main→worker) → `ReadableChannel<T>`
   * - `'out'` channels (worker→main) → `WritableChannel<T>`
   *
   * @param name  The channel name, as declared in `SpawnOptions.channels`.
   */
  channel<K extends string & keyof T>(name: K): WorkerSideChannel<T, K>;
}

// ---------------------------------------------------------------------------
// Pool worker context — pooled workers receiving discrete tasks
// ---------------------------------------------------------------------------

/**
 * Extended context for `scatter.pool()` workers. Adds the worker's pool index.
 *
 * Each pool worker has a stable zero-based `workerIndex` for the lifetime of
 * the pool. This is useful for partitioning state, sharding caches, or
 * assigning dedicated resources per worker.
 *
 * @example
 * ```ts
 * const pool = scatter.pool((ctx: PoolWorkerContext, input: number) => {
 *   console.log(`worker ${ctx.workerIndex} handling ${input}`);
 *   return heavyComputation(input);
 * }, { size: 4 });
 * ```
 */
export interface PoolWorkerContext extends ThreadContext {
  /**
   * Zero-based index of this worker within the pool.
   * Stable for the lifetime of the pool (does not change on task assignment).
   */
  readonly workerIndex: number;
}

// ---------------------------------------------------------------------------
// Max worker context — ephemeral saturating-parallelism workers
// ---------------------------------------------------------------------------

/**
 * Extended context for `scatter.max()` workers. Adds worker index and total
 * worker count for partition-aware computation.
 *
 * `scatter.max()` workers are scoped to a single computation — they are
 * created at call time and destroyed when the computation completes.
 * The `workerCount` is the actual number of workers spawned (equal to or less
 * than `navigator.hardwareConcurrency`).
 *
 * Use `workerIndex` and `workerCount` together to divide a dataset:
 *
 * @example
 * ```ts
 * const result = await scatter.max(
 *   (ctx: MaxWorkerContext, chunk: number[]) => {
 *     // Each worker processes its slice of the total dataset.
 *     const slice = chunk.slice(
 *       Math.floor((ctx.workerIndex / ctx.workerCount) * chunk.length),
 *       Math.floor(((ctx.workerIndex + 1) / ctx.workerCount) * chunk.length),
 *     );
 *     return slice.reduce((a, b) => a + b, 0);
 *   },
 *   {
 *     input: bigArray,
 *     split: (input, n) => Array.from({ length: n }, (_, i) =>
 *       input.slice(Math.floor((i / n) * input.length),
 *                  Math.floor(((i + 1) / n) * input.length)),
 *     ),
 *   },
 * ).collect();
 * ```
 */
export interface MaxWorkerContext extends ThreadContext {
  /**
   * Zero-based index of this worker within the max computation.
   * Ranges from `0` to `workerCount - 1`.
   */
  readonly workerIndex: number;

  /**
   * Total number of workers spawned for this computation.
   * Equal to `navigator.hardwareConcurrency` unless limited by input size.
   */
  readonly workerCount: number;
}
