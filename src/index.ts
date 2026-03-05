/**
 * Scatter — Inline Bun workers with lock-free shared-memory channels.
 *
 * Public API surface. Everything a user imports from `scatter.js` comes from here.
 *
 * Five API tiers:
 *   scatter()        — one-shot: offload a function to a thread
 *   scatter.spawn()  — persistent: long-lived worker with shared-memory channels
 *   scatter.pool()   — pooled: N workers with automatic task dispatch
 *   scatter.max()    — saturating: fill every core for a bounded computation
 *   NativeThreads    — raw pthreads via bun:ffi for maximum native performance
 *
 * @example
 * ```ts
 * import { scatter, Channel } from 'scatter.js';
 *
 * // One-shot
 * const pi = await scatter(() => computePi(1_000_000));
 *
 * // Pool
 * using pool = scatter.pool((ctx, n: number) => fib(n), { size: 8 });
 * const result = await pool.exec(42);
 *
 * // Spawn with channels
 * using handle = scatter.spawn(
 *   (ctx) => {
 *     for await (const x of ctx.channel('in')) {
 *       ctx.channel('out').write(x * 2);
 *     }
 *   },
 *   { channels: { in: Channel.in<number>(), out: Channel.out<number>() } },
 * );
 *
 * // Max — saturate all cores
 * const sums = await scatter.max(
 *   (ctx, chunk: number[]) => chunk.reduce((a, b) => a + b, 0),
 *   { inputs: chunks },
 * ).collect();
 * ```
 */

// ---------------------------------------------------------------------------
// Core API — the two things every user imports
// ---------------------------------------------------------------------------

export { scatter, Channel } from './runtime/index.js';

// ---------------------------------------------------------------------------
// Options & handles — for users who type-annotate their code
// ---------------------------------------------------------------------------

export type { ScatterOptions } from './scatter.js';
export type { SpawnOptions, ThreadHandle } from './scatter.js';
export type { PoolOptions, ThreadPool, PoolStats, ExecOptions } from './scatter.js';
export type {
  MaxBatchOptions,
  MaxSplitOptions,
  MaxResult,
} from './scatter.js';
export type { ChannelDefOptions } from './scatter.js';

// ---------------------------------------------------------------------------
// Context types — used inside worker function signatures
// ---------------------------------------------------------------------------

export type {
  ThreadContext,
  SpawnContext,
  PoolWorkerContext,
  MaxWorkerContext,
} from './context.js';

// ---------------------------------------------------------------------------
// Channel interfaces — for typing variables that hold channel references
// ---------------------------------------------------------------------------

export type {
  ReadableChannel,
  WritableChannel,
  SharedChannel,
} from './memory/shared-channel.js';

// ---------------------------------------------------------------------------
// Errors — value exports so instanceof checks work
// ---------------------------------------------------------------------------

export {
  ScatterError,
  ThreadExecutionError,
  ThreadTimeoutError,
  ThreadAbortError,
  WorkerCrashedError,
  MaterializationError,
  ChannelClosedError,
  ChannelFullError,
  PoolTerminatedError,
} from './error.js';

// ---------------------------------------------------------------------------
// Custom codec interface — for power users who build custom serializers
// ---------------------------------------------------------------------------

export type { Codec } from './memory/codec.js';

// ---------------------------------------------------------------------------
// Native threads — raw pthreads via bun:ffi for maximum performance
// ---------------------------------------------------------------------------

export { NativeThreads, NativeThreadError } from './native/index.js';
export type {
  NativeBurnResult,
  NativeBurnOptions,
  NativeThreadsOptions,
} from './native/index.js';
