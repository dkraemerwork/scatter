/**
 * Scatter — Public API contract.
 *
 * Four API tiers, one import:
 *
 *   scatter()        — one-shot: run a function on a fresh thread, get a result
 *   scatter.spawn()  — persistent: long-lived worker with typed shared-memory channels
 *   scatter.pool()   — pooled: N workers with automatic task dispatch and backpressure
 *   scatter.max()    — saturating: fill every available core for a bounded computation
 *
 * Plus the `Channel` helper for declaring direction-typed channel definitions.
 *
 * NO IMPLEMENTATION — only types and signatures. Implementation lives in the
 * `./runtime/` directory. These declarations form the public contract.
 *
 * @example
 * ```ts
 * import { scatter, Channel } from 'scatter.js';
 *
 * // One-shot
 * const pi = await scatter(() => computePi(1_000_000));
 *
 * // Pooled
 * const pool = scatter.pool((ctx, n: number) => fib(n));
 * const result = await pool.exec(42);
 * await pool.terminate();
 *
 * // Spawned with channels
 * using handle = scatter.spawn(
 *   (ctx) => { for await (const x of ctx.channel('in')) ctx.channel('out').write(x * 2); },
 *   { channels: { in: Channel.in<number>(), out: Channel.out<number>() } },
 * );
 * handle.channels.in.write(21);
 * const doubled = await handle.channels.out.readAsync(); // 42
 *
 * // Max-parallelism
 * const sums = await scatter.max(
 *   (ctx, chunk: number[]) => chunk.reduce((a, b) => a + b, 0),
 *   { inputs: chunkArray },
 * ).collect();
 * ```
 */

import type {
  ThreadContext,
  SpawnContext,
  PoolWorkerContext,
  MaxWorkerContext,
} from './context.js';
import type {
  ChannelDef,
  ChannelDefinitions,
  InferChannelType,
  MainSideChannels,
} from './memory/shared-channel.js';
import type { CodecLike } from './memory/codec.js';

// ---------------------------------------------------------------------------
// scatter() — One-shot execution
// ---------------------------------------------------------------------------

/**
 * Run a function on a separate thread and return its result.
 *
 * The worker is created, executes the function, returns the value, and is
 * destroyed — all automatically. No files, no boilerplate.
 *
 * The function runs in a fully isolated scope. It has **no access** to the
 * calling closure's variables. Use `options.data` to pass serializable values,
 * and `options.imports` to make module imports available inside the worker.
 *
 * @typeParam R  The return type of the worker function.
 *
 * @param fn       The function to run on a worker thread.
 * @param options  Optional timeout, signal, imports, and data.
 * @returns        A promise that resolves with the function's return value.
 *
 * @example
 * ```ts
 * // Basic usage
 * const sum = await scatter((ctx) => {
 *   let total = 0;
 *   for (let i = 0; i < 1_000_000_000; i++) total += i;
 *   return total;
 * });
 * ```
 *
 * @example
 * ```ts
 * // Passing data and using a timeout
 * const hash = await scatter(
 *   (ctx) => {
 *     const hasher = new Bun.CryptoHasher('sha256');
 *     hasher.update(ctx.data.payload as string);
 *     return hasher.digest('hex');
 *   },
 *   { data: { payload: 'hello world' }, timeout: 5000 },
 * );
 * ```
 *
 * @example
 * ```ts
 * // Cancellation via AbortSignal
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 1000);
 *
 * const result = await scatter(() => longRunning(), { signal: controller.signal });
 * ```
 */
export declare function scatter<R>(
  fn: (ctx: ThreadContext) => R | Promise<R>,
  options?: ScatterOptions,
): Promise<R>;

/**
 * Options for `scatter()`.
 *
 * @example
 * ```ts
 * const options: ScatterOptions = {
 *   timeout: 10_000,
 *   data: { threshold: 0.95 },
 *   imports: ['lodash', 'zod'],
 * };
 * ```
 */
export interface ScatterOptions {
  /**
   * Maximum execution time in milliseconds.
   * The worker is forcibly terminated if the function does not complete
   * within this window. The promise rejects with a `TimeoutError`.
   */
  readonly timeout?: number;

  /**
   * External cancellation signal.
   * Aborting terminates the worker immediately. The promise rejects with
   * the signal's abort reason (or `AbortError` if no reason was set).
   */
  readonly signal?: AbortSignal;

  /**
   * Bare module specifiers to inject as `import` statements at the top of the
   * worker script. Modules are resolved relative to the main thread's CWD.
   *
   * @example `['./my-lib.js', 'some-npm-package']`
   */
  readonly imports?: readonly string[];

  /**
   * Serializable data available as `ctx.data` inside the worker.
   * Transmitted once via structured clone during worker initialization.
   * Must be serializable with the structured-clone algorithm.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// scatter.spawn() / scatter.pool() / scatter.max() — namespace declarations
// ---------------------------------------------------------------------------

export declare namespace scatter {
  // -------------------------------------------------------------------------
  // scatter.spawn() — Persistent worker with shared-memory channels
  // -------------------------------------------------------------------------

  /**
   * Spawn a long-lived worker with named, direction-typed shared-memory channels.
   *
   * Channels use `SharedArrayBuffer` + lock-free ring buffers for zero-copy,
   * cross-thread communication with no serialization overhead for binary codecs.
   *
   * Channel direction is enforced at the type level:
   * - `Channel.in<T>()` — main thread writes, worker reads
   * - `Channel.out<T>()` — worker writes, main thread reads
   *
   * The returned {@link ThreadHandle} supports `using` declarations for
   * automatic cleanup via `Symbol.dispose`.
   *
   * @typeParam T  The channel definitions map.
   *
   * @param fn       Worker function. Receives a {@link SpawnContext} with typed channel access.
   * @param options  Channel definitions, imports, data, and optional signal.
   * @returns        A {@link ThreadHandle} for channel I/O and lifecycle control.
   *
   * @example
   * ```ts
   * type Channels = {
   *   tasks:   typeof Channel.in<Task>;
   *   results: typeof Channel.out<Result>;
   * };
   *
   * using handle = scatter.spawn(
   *   (ctx) => {
   *     const tasks   = ctx.channel('tasks');   // ReadableChannel<Task>
   *     const results = ctx.channel('results'); // WritableChannel<Result>
   *
   *     for await (const task of tasks) {
   *       results.write({ id: task.id, value: task.value * 2 });
   *     }
   *     results.close();
   *   },
   *   {
   *     channels: {
   *       tasks:   Channel.in<Task>(),
   *       results: Channel.out<Result>(),
   *     },
   *   },
   * );
   *
   * handle.channels.tasks.write({ id: 1, value: 21 });     // WritableChannel<Task>
   * const res = await handle.channels.results.readAsync(); // ReadableChannel<Result>
   * // handle auto-terminates when `using` block exits
   * ```
   */
  function spawn<T extends ChannelDefinitions>(
    fn: (ctx: SpawnContext<T>) => void | Promise<void>,
    options: SpawnOptions<T>,
  ): ThreadHandle<T>;

  // -------------------------------------------------------------------------
  // scatter.pool() — Worker pool with task dispatch
  // -------------------------------------------------------------------------

  /**
   * Create a pool of N workers that process tasks in parallel.
   *
   * Workers are pre-spawned and reused across tasks. Tasks are dispatched
   * according to the configured `strategy`. The pool manages backpressure
   * via `maxQueue` and supports per-task cancellation via `AbortSignal`.
   *
   * The returned {@link ThreadPool} supports `using` declarations for
   * automatic cleanup via `Symbol.dispose`.
   *
   * @typeParam TIn   The type of input passed to each task.
   * @typeParam TOut  The return type of each task.
   *
   * @param fn       Worker function. Receives a {@link PoolWorkerContext} and an input value.
   * @param options  Pool configuration: size, concurrency, strategy, imports, data.
   * @returns        A {@link ThreadPool} for task submission and lifecycle control.
   *
   * @example
   * ```ts
   * using pool = scatter.pool(
   *   (ctx, n: number) => {
   *     let count = 0;
   *     for (let i = 2; i <= n; i++) {
   *       let prime = true;
   *       for (let j = 2; j * j <= i; j++) {
   *         if (i % j === 0) { prime = false; break; }
   *       }
   *       if (prime) count++;
   *     }
   *     return count;
   *   },
   *   { size: 8, concurrency: 2 },
   * );
   *
   * // Single task
   * const count = await pool.exec(10_000_000);
   *
   * // Batch — results stream in as workers complete
   * for await (const result of pool.execMany([1_000, 10_000, 100_000])) {
   *   console.log(result);
   * }
   * // pool auto-terminates when `using` block exits
   * ```
   */
  function pool<TIn, TOut>(
    fn: (ctx: PoolWorkerContext, input: TIn) => TOut | Promise<TOut>,
    options?: PoolOptions,
  ): ThreadPool<TIn, TOut>;

  // -------------------------------------------------------------------------
  // scatter.max() — Saturate all CPU cores for a bounded computation
  // -------------------------------------------------------------------------

  /**
   * Distribute a batch of inputs across all available CPU cores.
   *
   * The **batch overload** accepts a pre-divided iterable of inputs — each
   * item is dispatched to a worker. Use this when you already have discrete
   * units of work.
   *
   * Workers are scoped to this computation: they are spawned at call time and
   * destroyed when the last result is consumed or `abort()` is called.
   *
   * Unlike `scatter.pool()`, `max()` is **fire-and-forget scoped** — there is
   * no persistent pool to manage.
   *
   * @typeParam TIn   The type of each input item.
   * @typeParam TOut  The return type of each worker invocation.
   *
   * @param fn       Worker function. Receives a {@link MaxWorkerContext} and one input.
   * @param options  Batch options: `inputs` iterable, plus optional imports and data.
   * @returns        A {@link MaxResult} that is async-iterable and collectable.
   *
   * @example
   * ```ts
   * // Batch: already-chunked inputs
   * const chunks: number[][] = partition(bigArray, navigator.hardwareConcurrency);
   *
   * const partialSums = await scatter.max(
   *   (ctx, chunk: number[]) => chunk.reduce((a, b) => a + b, 0),
   *   { inputs: chunks },
   * ).collect();
   *
   * const total = partialSums.reduce((a, b) => a + b, 0);
   * ```
   */
  function max<TIn, TOut>(
    fn: (ctx: MaxWorkerContext, input: TIn) => TOut | Promise<TOut>,
    options: MaxBatchOptions<TIn>,
  ): MaxResult<TOut>;

  /**
   * Automatically split a single input across all available CPU cores.
   *
   * The **split overload** accepts a single large input and a `split` function
   * that divides it into `n` chunks (one per worker). Scatter determines `n`
   * based on `navigator.hardwareConcurrency` and available resources.
   *
   * This is the idiomatic way to parallelize a large data structure without
   * pre-chunking on the caller's side.
   *
   * @typeParam TIn   The type of the full (unsplit) input.
   * @typeParam TOut  The return type of each worker invocation.
   *
   * @param fn       Worker function. Receives a {@link MaxWorkerContext} and one chunk.
   * @param options  Split options: `input`, `split` function, plus optional imports and data.
   * @returns        A {@link MaxResult} that is async-iterable and collectable.
   *
   * @example
   * ```ts
   * // Split: let scatter divide the work automatically
   * const partialSums = await scatter.max(
   *   (ctx, chunk: number[]) => chunk.reduce((a, b) => a + b, 0),
   *   {
   *     input: Array.from({ length: 10_000_000 }, (_, i) => i),
   *     split: (arr, n) => Array.from({ length: n }, (_, i) =>
   *       arr.slice(
   *         Math.floor((i / n) * arr.length),
   *         Math.floor(((i + 1) / n) * arr.length),
   *       ),
   *     ),
   *   },
   * ).collect();
   *
   * const total = partialSums.reduce((a, b) => a + b, 0);
   * ```
   */
  function max<TIn, TOut>(
    fn: (ctx: MaxWorkerContext, chunk: TIn) => TOut | Promise<TOut>,
    options: MaxSplitOptions<TIn>,
  ): MaxResult<TOut>;
}

// ---------------------------------------------------------------------------
// scatter.spawn() — Options and handle
// ---------------------------------------------------------------------------

/**
 * Options for `scatter.spawn()`.
 *
 * @typeParam T  The channel definitions map.
 *
 * @example
 * ```ts
 * const options: SpawnOptions<typeof channels> = {
 *   channels: {
 *     tasks:   Channel.in<Task>(),
 *     results: Channel.out<Result>(),
 *   },
 *   data: { batchSize: 64 },
 *   timeout: 30_000,
 * };
 * ```
 */
export interface SpawnOptions<T extends ChannelDefinitions = ChannelDefinitions> {
  /**
   * Named channel definitions. Each entry becomes a `SharedChannel` backed by
   * a `SharedArrayBuffer` ring buffer. The direction determines which side
   * reads and which side writes.
   *
   * Use `Channel.in<T>()` for main→worker and `Channel.out<T>()` for worker→main.
   */
  readonly channels: T;

  /**
   * Bare module specifiers to inject as `import` statements inside the worker.
   * Resolved relative to the main thread's CWD.
   */
  readonly imports?: readonly string[];

  /**
   * Serializable data available as `ctx.data` inside the worker.
   * Transmitted via structured clone during worker initialization.
   */
  readonly data?: Readonly<Record<string, unknown>>;

  /**
   * External cancellation signal.
   * Aborting terminates the worker and closes all channels.
   */
  readonly signal?: AbortSignal;
}

/**
 * Handle to a spawned worker. Provides direction-typed channel access and
 * lifecycle control.
 *
 * Implements both `Symbol.dispose` (sync) and `Symbol.asyncDispose` (async)
 * for use with `using` and `await using` declarations respectively.
 *
 * @typeParam T  The channel definitions map provided at spawn time.
 *
 * @example
 * ```ts
 * // Automatic cleanup with `using`
 * {
 *   using handle = scatter.spawn(workerFn, { channels: myChannels });
 *   handle.channels.tasks.write(payload);
 *   const result = await handle.channels.results.readAsync();
 * } // handle.terminate() called automatically here
 *
 * // Manual lifecycle
 * const handle = scatter.spawn(workerFn, { channels: myChannels });
 * await handle.shutdown(); // graceful drain then terminate
 * ```
 */
export interface ThreadHandle<T extends ChannelDefinitions = ChannelDefinitions> {
  /**
   * Named channels, direction-typed for the **main thread** side:
   * - `Channel.in<T>()` channels → `WritableChannel<T>` (main writes)
   * - `Channel.out<T>()` channels → `ReadableChannel<T>` (main reads)
   */
  readonly channels: MainSideChannels<T>;

  /**
   * Forcibly terminate the worker immediately.
   * In-flight operations are abandoned. All channels are closed.
   * Pending `readAsync()` / `writeBlocking()` calls resolve/reject immediately.
   */
  terminate(): void;

  /**
   * Gracefully shut down the worker.
   *
   * Closes all `Channel.in` (main→worker) channels to signal end-of-input,
   * then waits for the worker function to return naturally. Use this instead
   * of `terminate()` when you need the worker to drain its queue cleanly.
   *
   * @returns A promise that resolves once the worker has exited.
   */
  shutdown(): Promise<void>;

  /**
   * Whether the worker is still running.
   * `false` after `terminate()`, `shutdown()`, or an unhandled error.
   */
  readonly alive: boolean;

  /**
   * Unique numeric identifier for the underlying worker thread.
   * Stable for the lifetime of the handle; not reused after termination.
   */
  readonly threadId: number;

  /**
   * Synchronous dispose. Calls `terminate()`.
   * Enables `using handle = scatter.spawn(...)` syntax.
   */
  [Symbol.dispose](): void;

  /**
   * Asynchronous dispose. Calls `shutdown()`.
   * Enables `await using handle = scatter.spawn(...)` syntax.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

// ---------------------------------------------------------------------------
// scatter.pool() — Options and handle
// ---------------------------------------------------------------------------

/**
 * Options for `scatter.pool()`.
 *
 * @example
 * ```ts
 * const options: PoolOptions = {
 *   size: 8,
 *   concurrency: 2,   // each worker handles 2 tasks simultaneously
 *   maxQueue: 256,
 *   strategy: 'least-busy',
 * };
 * ```
 */
export interface PoolOptions {
  /**
   * Number of workers in the pool.
   *
   * Defaults to `navigator.hardwareConcurrency` (number of logical CPU cores).
   * On Bun, this is the same as `os.availableParallelism()`.
   */
  readonly size?: number;

  /**
   * Maximum number of tasks that may be queued waiting for a free worker slot.
   * When the queue is full, `exec()` will apply backpressure (await or reject
   * depending on pool configuration).
   *
   * Defaults to unbounded.
   */
  readonly maxQueue?: number;

  /**
   * How to select which worker receives the next queued task.
   *
   * - `'round-robin'` — rotate through workers in order (default).
   * - `'least-busy'`  — pick the worker with the fewest active tasks.
   */
  readonly strategy?: 'round-robin' | 'least-busy';

  /**
   * Number of tasks each worker may process simultaneously.
   *
   * When `concurrency > 1`, a single worker can interleave multiple async
   * tasks. This is useful for I/O-heavy work where a worker would otherwise
   * idle waiting on a network or disk operation.
   *
   * Defaults to `1` (one task per worker at a time).
   */
  readonly concurrency?: number;

  /**
   * Bare module specifiers to inject as `import` statements inside each worker.
   * Resolved relative to the main thread's CWD.
   */
  readonly imports?: readonly string[];

  /**
   * Serializable data available as `ctx.data` inside every worker.
   * Transmitted via structured clone during worker initialization.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Options that can be passed per `exec()` call on a {@link ThreadPool}.
 *
 * @example
 * ```ts
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 2000);
 *
 * const result = await pool.exec(heavyInput, { signal: controller.signal });
 * ```
 */
export interface ExecOptions {
  /**
   * Per-task cancellation signal.
   * If aborted before the task is picked up, the task is removed from the
   * queue and the promise rejects with the abort reason.
   * If aborted while a worker is executing, the worker is interrupted and
   * the promise rejects with the abort reason.
   */
  readonly signal?: AbortSignal;
}

/**
 * Handle to a worker pool. Dispatch tasks, stream results, drain, and terminate.
 *
 * Implements both `Symbol.dispose` (sync) and `Symbol.asyncDispose` (async)
 * for use with `using` and `await using` declarations respectively.
 *
 * When `terminate()` is called, **all pending tasks are rejected** with a
 * `PoolTerminatedError`. In-flight tasks on workers are also cancelled.
 *
 * @typeParam TIn   The input type for tasks.
 * @typeParam TOut  The output type returned by each task.
 *
 * @example
 * ```ts
 * await using pool = scatter.pool(
 *   (ctx, url: string) => fetch(url).then(r => r.json()),
 *   { size: 4, concurrency: 8 }, // 4 workers × 8 concurrent = 32 parallel fetches
 * );
 *
 * const results = await Promise.all(urls.map(url => pool.exec(url)));
 * ```
 */
export interface ThreadPool<TIn, TOut> {
  /**
   * Submit a single task to the pool.
   *
   * The returned promise resolves when a worker completes the task, or rejects
   * if the task is cancelled via `options.signal`, the pool is terminated, or
   * the worker function throws.
   *
   * @param input    The value to pass to the worker function.
   * @param options  Per-task options including an optional `AbortSignal`.
   */
  exec(input: TIn, options?: ExecOptions): Promise<TOut>;

  /**
   * Submit a batch of tasks. Results are yielded as they complete —
   * **not necessarily in input order**.
   *
   * The async iterable completes once all submitted tasks have resolved or
   * rejected. Individual task errors are re-thrown by the iterator.
   *
   * @param inputs  An iterable of input values.
   */
  execMany(inputs: Iterable<TIn>): AsyncIterable<TOut>;

  /**
   * Wait for all currently in-flight and queued tasks to complete.
   * Resolves once the pool is fully idle.
   */
  drain(): Promise<void>;

  /**
   * Terminate all workers immediately.
   *
   * All pending tasks (both queued and in-flight) are **rejected** with a
   * `PoolTerminatedError`. The pool cannot be reused after termination.
   */
  terminate(): void;

  /**
   * Gracefully shut down the pool.
   *
   * Stops accepting new tasks, waits for all queued and in-flight tasks to
   * complete, then terminates all workers.
   *
   * @returns A promise that resolves once all tasks are done and workers exit.
   */
  shutdown(): Promise<void>;

  /**
   * Live statistics about the pool.
   * The object is a snapshot — values may have changed by the time you read them.
   */
  readonly stats: PoolStats;

  /**
   * Synchronous dispose. Calls `terminate()` and rejects all pending tasks.
   * Enables `using pool = scatter.pool(...)` syntax.
   */
  [Symbol.dispose](): void;

  /**
   * Asynchronous dispose. Calls `shutdown()` and drains all tasks cleanly.
   * Enables `await using pool = scatter.pool(...)` syntax.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * A snapshot of pool runtime statistics.
 *
 * @example
 * ```ts
 * const { activeWorkers, pendingTasks, completedTasks } = pool.stats;
 * console.log(`${activeWorkers} active, ${pendingTasks} pending, ${completedTasks} done`);
 * ```
 */
export interface PoolStats {
  /** Number of workers currently executing at least one task. */
  readonly activeWorkers: number;

  /** Number of tasks currently queued and awaiting a free worker slot. */
  readonly pendingTasks: number;

  /** Cumulative total of tasks completed since the pool was created. */
  readonly completedTasks: number;

  /**
   * Number of workers currently alive (not terminated or crashed).
   * Normally equals `PoolOptions.size`. May be lower if workers have exited
   * due to uncaught errors.
   */
  readonly workersAlive: number;
}

// ---------------------------------------------------------------------------
// scatter.max() — Options and result
// ---------------------------------------------------------------------------

/**
 * Shared base options for both `scatter.max()` overloads.
 *
 * @internal Extended by {@link MaxBatchOptions} and {@link MaxSplitOptions}.
 */
interface MaxBaseOptions {
  /**
   * Bare module specifiers to inject inside each max worker.
   * Resolved relative to the main thread's CWD.
   */
  readonly imports?: readonly string[];

  /**
   * Serializable data available as `ctx.data` inside each worker.
   * Transmitted via structured clone during worker initialization.
   */
  readonly data?: Readonly<Record<string, unknown>>;

  /**
   * External cancellation signal.
   * Aborting calls `MaxResult.abort()` and rejects all pending results.
   */
  readonly signal?: AbortSignal;
}

/**
 * Options for the batch overload of `scatter.max()`.
 *
 * Provide a pre-divided iterable of inputs. Each item is sent to one worker
 * invocation. The number of parallel workers is `min(inputs.length, hardwareConcurrency)`.
 *
 * @typeParam TIn  The type of each individual input item.
 *
 * @example
 * ```ts
 * const options: MaxBatchOptions<number[]> = {
 *   inputs: chunkedData,
 * };
 * ```
 */
export interface MaxBatchOptions<TIn> extends MaxBaseOptions {
  /**
   * The pre-divided inputs. Each item maps to one worker call.
   * May be a lazy `Iterable` — scatter will pull items as workers become free.
   */
  readonly inputs: Iterable<TIn>;
}

/**
 * Options for the split overload of `scatter.max()`.
 *
 * Provide a single large input and a `split` function. Scatter will call
 * `split(input, n)` where `n` is the number of workers to spawn, and
 * distribute the resulting chunks across workers automatically.
 *
 * @typeParam TIn  The type of the full (unsplit) input.
 *
 * @example
 * ```ts
 * const options: MaxSplitOptions<number[]> = {
 *   input: largeArray,
 *   split: (arr, n) => Array.from({ length: n }, (_, i) =>
 *     arr.slice(
 *       Math.floor((i / n) * arr.length),
 *       Math.floor(((i + 1) / n) * arr.length),
 *     ),
 *   ),
 * };
 * ```
 */
export interface MaxSplitOptions<TIn> extends MaxBaseOptions {
  /**
   * The full input to split across workers.
   * Passed as the first argument to `split`.
   */
  readonly input: TIn;

  /**
   * A function that divides `input` into exactly `n` chunks.
   * Called once by scatter before spawning workers.
   *
   * @param input  The full input value.
   * @param n      The number of chunks to produce (equals worker count).
   * @returns      An iterable of `n` chunks, one per worker.
   */
  readonly split: (input: TIn, n: number) => Iterable<TIn>;
}

/**
 * The result handle returned by `scatter.max()`.
 *
 * Implements `AsyncIterable<T>` — results are yielded in **completion order**
 * (fastest workers first). Use `collectOrdered()` if input order matters.
 *
 * The computation runs eagerly: workers start immediately when `max()` is called,
 * regardless of whether you await the result.
 *
 * @typeParam T  The output type of each worker invocation.
 *
 * @example
 * ```ts
 * const result = scatter.max(fn, { inputs: chunks });
 *
 * // Stream results as they arrive
 * for await (const partial of result) {
 *   accumulate(partial);
 * }
 *
 * // Or collect all at once
 * const all = await result.collect();
 *
 * // Cancel if taking too long
 * setTimeout(() => result.abort(), 5000);
 * ```
 */
export interface MaxResult<T> extends AsyncIterable<T> {
  /**
   * Collect all results into an array.
   *
   * Results are in **completion order** — the fastest worker's output appears
   * first. Use `collectOrdered()` if you need input-index order.
   *
   * @returns A promise that resolves with all results once every worker completes.
   */
  collect(): Promise<T[]>;

  /**
   * Collect all results into an array in **input order**.
   *
   * Waits for all workers to complete and re-sorts the results to match the
   * original input sequence. Slightly higher memory overhead than `collect()`
   * since results must be buffered until all workers finish.
   *
   * @returns A promise that resolves with results indexed to match inputs.
   */
  collectOrdered(): Promise<T[]>;

  /**
   * Cancel all in-progress and queued work.
   *
   * Workers that are currently executing are interrupted. The async iterator
   * completes immediately. Any unresolved `collect()` / `collectOrdered()`
   * promises reject with an `AbortError`.
   */
  abort(): void;

  /**
   * Number of worker invocations that have completed (resolved or rejected)
   * so far. Updated in real-time as workers finish.
   */
  readonly completed: number;

  /**
   * Total number of worker invocations scheduled.
   *
   * `undefined` if the inputs iterable has not been fully consumed yet
   * (e.g. a lazy generator where length is not known upfront).
   * Becomes defined once all inputs have been dispatched.
   */
  readonly total: number | undefined;

  /**
   * Async iterator. Yields results in completion order as workers finish.
   * Completes when all workers are done or `abort()` has been called.
   *
   * @example
   * ```ts
   * for await (const partial of scatter.max(fn, { inputs })) {
   *   console.log(partial);
   * }
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

// ---------------------------------------------------------------------------
// Channel — static helper for declaring direction-typed channel definitions
// ---------------------------------------------------------------------------

/**
 * Options accepted by `Channel.in()` and `Channel.out()`.
 *
 * @typeParam T  The type of values flowing through the channel.
 *
 * @example
 * ```ts
 * Channel.in<Uint8Array>({ capacity: 1024 * 1024, codec: 'raw' })
 * ```
 */
export interface ChannelDefOptions<T> {
  /**
   * Ring buffer capacity in bytes.
   * Default: `65536` (64 KiB). Increase for high-throughput or large messages.
   */
  readonly capacity?: number;

  /**
   * Codec for value serialization/deserialization.
   * Can be a built-in name (`'raw'`, `'number'`, `'string'`, `'json'`,
   * `'structured'`) or a custom `Codec<T>` instance.
   *
   * Default: `'structured'` (uses the structured-clone algorithm).
   */
  readonly codec?: CodecLike<T>;
}

/**
 * Ergonomic helper for declaring direction-typed channel definitions in
 * `scatter.spawn({ channels: { ... } })`.
 *
 * Replaces the old `Channel.of()` API with two explicit directional methods
 * that make the data-flow intent clear at a glance.
 *
 * @example
 * ```ts
 * const handle = scatter.spawn(workerFn, {
 *   channels: {
 *     // main thread writes tasks, worker reads
 *     tasks:    Channel.in<Task>(),
 *
 *     // worker writes results, main thread reads
 *     results:  Channel.out<Result>(),
 *
 *     // custom capacity and codec
 *     frames:   Channel.in<Uint8Array>({ capacity: 1024 * 1024, codec: 'raw' }),
 *
 *     // JSON codec for complex objects
 *     events:   Channel.out<AppEvent>({ codec: 'json' }),
 *   },
 * });
 *
 * // Main thread: direction-typed access
 * handle.channels.tasks.write(nextTask);        // WritableChannel<Task>
 * const res = handle.channels.results.read();   // ReadableChannel<Result>
 * ```
 */
export declare const Channel: {
  /**
   * Define an **inbound** channel: main thread writes, worker reads.
   *
   * On the main thread, `handle.channels.<name>` will be a `WritableChannel<T>`.
   * Inside the worker, `ctx.channel('<name>')` will be a `ReadableChannel<T>`.
   *
   * @typeParam T      The type of values flowing from main → worker.
   * @param options    Optional capacity and codec configuration.
   * @returns          A `ChannelDef<T>` with `direction: 'in'`.
   *
   * @example
   * ```ts
   * channels: {
   *   tasks: Channel.in<Task>({ capacity: 128 * 1024 }),
   * }
   * ```
   */
  in<T>(options?: ChannelDefOptions<T>): ChannelDef<T> & { readonly direction: 'in' };

  /**
   * Define an **outbound** channel: worker writes, main thread reads.
   *
   * On the main thread, `handle.channels.<name>` will be a `ReadableChannel<T>`.
   * Inside the worker, `ctx.channel('<name>')` will be a `WritableChannel<T>`.
   *
   * @typeParam T      The type of values flowing from worker → main.
   * @param options    Optional capacity and codec configuration.
   * @returns          A `ChannelDef<T>` with `direction: 'out'`.
   *
   * @example
   * ```ts
   * channels: {
   *   results: Channel.out<Result>({ codec: 'json' }),
   * }
   * ```
   */
  out<T>(options?: ChannelDefOptions<T>): ChannelDef<T> & { readonly direction: 'out' };
};
