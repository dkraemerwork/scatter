/**
 * @Scaled() — method decorator for offloading individual methods to worker threads.
 *
 * Supports two modes:
 * - Oneshot (default): Each call spawns a fresh worker via scatter().
 * - Pool: Calls are dispatched to a shared worker pool via scatter.pool().
 *
 * Compatible with both TC39 Stage 3 decorators and Bun's current legacy
 * method-decorator transform.
 */

import type { PoolWorkerContext, ThreadContext } from '../context.js';
import type { ThreadPool } from '../scatter.js';
import { scatter } from '../runtime/index.js';
import { buildOneshotWorkerFn, buildPoolWorkerFn, normalizeMethodSource } from './build-worker-fn.js';
import type { WorkerPayload } from './build-worker-fn.js';
import { serializeState } from './serialize-state.js';

/**
 * Module-level registry mapping original method functions to their ThreadPool instances.
 *
 * Key identity: In TC39 Stage 3 decorators, the `value` parameter is the method's
 * function object. Each class definition produces a unique function reference per method,
 * so two different classes defining `compute()` get different WeakMap entries (and thus
 * separate pools). Using WeakMap allows entries to be collectible if no strong references
 * to the original function remain — though pools are also held by `allDecoratorPools`.
 */
export const scaledPools = new WeakMap<Function, ThreadPool<WorkerPayload, unknown>>();

/**
 * Global registry of ALL decorator-created pools (both @Scaled and @WorkerClass).
 *
 * This Set holds strong references to every pool created by the decorator layer.
 * It serves as the single source of truth for `cleanupAllDecoratorPools()`, which
 * iterates this set and shuts down every pool.
 *
 * Pools are NEVER automatically removed — they remain in this set until explicitly
 * cleaned up via `cleanupAllDecoratorPools()` or per-class `disposeWorkers()`.
 */
export const allDecoratorPools = new Set<ThreadPool<WorkerPayload, unknown>>();

/** Options for @Scaled() */
export interface ScaledOptions {
  /**
   * Pool configuration.
   * - `number`: create a pool of exactly that size (must be >= 1, positive integer;
   *   throws TypeError if invalid — matches scatter.pool() runtime validation)
   * - `true`: pool of size navigator.hardwareConcurrency (fallback: 4, with typeof guard)
   * - omitted / `false`: oneshot mode — fresh worker per call via scatter()
   *
   * @default false (oneshot)
   */
  readonly pool?: number | boolean;

  /**
   * Per-worker concurrency within the pool.
   * Only meaningful when `pool` is set.
   * @default 1
   */
  readonly concurrency?: number;

  /**
   * Dispatch strategy for pool mode.
   * @default 'round-robin'
   */
  readonly strategy?: 'round-robin' | 'least-busy';

  /**
   * Additional imports to inject into the worker.
   * Same semantics as ScatterOptions.imports.
   */
  readonly imports?: readonly string[];

  /**
   * Timeout in milliseconds per call.
   * Only meaningful in oneshot mode — if `pool` is set, this option is ignored
   * and a console.warn is emitted at decoration time.
   *
   * For pool-mode timeouts, use the scatter.pool() API directly.
   */
  readonly timeout?: number;

  /**
   * Maximum queue size for pool mode.
   * Only meaningful when `pool` is set. When the queue is full, exec() rejects.
   * @default Infinity (unbounded — matches scatter.pool() default)
   */
  readonly maxQueue?: number;
}

/**
 * Lazily create or retrieve a pool for the given original method function.
 *
 * IMPORTANT ASSUMPTION: scatter.pool() is SYNCHRONOUS — it returns a ThreadPool
 * immediately without yielding to the event loop. This guarantees that the
 * has() → set() sequence below cannot interleave between concurrent callers
 * within a single event loop tick.
 */
function getOrCreatePool(
  originalFn: Function,
  poolWorkerFn: (ctx: PoolWorkerContext, input: WorkerPayload) => unknown,
  options: ScaledOptions,
): ThreadPool<WorkerPayload, unknown> {
  if (scaledPools.has(originalFn)) return scaledPools.get(originalFn)!;

  const rawPoolSize = options.pool === true
    ? ((typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) ?? 4)
    : (options.pool as number);

  if (typeof rawPoolSize !== 'number' || rawPoolSize < 1 || !Number.isInteger(rawPoolSize)) {
    throw new TypeError(
      `[scatter] @Scaled: pool size must be a positive integer, got ${rawPoolSize}`,
    );
  }

  const concurrency = options.concurrency ?? 1;
  if (typeof concurrency !== 'number' || concurrency < 1 || !Number.isInteger(concurrency)) {
    throw new TypeError(
      `[scatter] @Scaled: concurrency must be a positive integer, got ${concurrency}`,
    );
  }

  const pool = scatter.pool(poolWorkerFn, {
    size: rawPoolSize,
    concurrency,
    strategy: options.strategy ?? 'round-robin',
    imports: options.imports as string[] | undefined,
    ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
  });

  scaledPools.set(originalFn, pool);
  allDecoratorPools.add(pool);
  return pool;
}

/**
 * Method decorator factory for offloading methods to worker threads.
 *
 * @example
 * ```ts
 * class MathService {
 *   @Scaled()
 *   heavyCompute(n: number): number { ... }
 *
 *   @Scaled({ pool: 4, strategy: 'least-busy' })
 *   fibonacci(n: number): number { ... }
 * }
 *
 * const svc = new MathService();
 * const result = await svc.heavyCompute(1_000_000);
 * ```
 */
/**
 * Type helper that expresses the post-decoration return type of a `@Scaled` method.
 *
 * The decorated method's return type changes to `Promise<Awaited<R>>`, but TypeScript
 * cannot express this type change via the decorator signature alone. Use this type
 * for explicit annotations when needed.
 *
 * @example
 * ```ts
 * class MathService {
 *   @Scaled()
 *   heavyCompute!: ScaledMethod<(n: number) => number>; // explicit type
 * }
 * ```
 */
export type ScaledMethod<F extends (...args: unknown[]) => unknown> =
  (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>;

type DecoratedMethod<This, Args extends unknown[], Return> =
  (this: This, ...args: Args) => Return;

type Stage3MethodContext<This, Args extends unknown[], Return> =
  ClassMethodDecoratorContext<This, DecoratedMethod<This, Args, Return>>;

function createScaledMethodWrapper<This, Args extends unknown[], Return>(
  originalFn: DecoratedMethod<This, Args, Return>,
  methodName: string,
  isStatic: boolean,
  options?: ScaledOptions,
): (this: This, ...args: Args) => Promise<Awaited<Return>> {
  const normalizedFnSource = normalizeMethodSource(originalFn.toString());
  const usePool = !!(options?.pool);

  if (usePool && options?.timeout !== undefined) {
    console.warn(
      `[scatter] @Scaled on '${methodName}': timeout option is ignored in pool mode. ` +
      `Use scatter.pool() directly for per-task timeouts.`,
    );
  }

  const poolWorkerFn = usePool ? buildPoolWorkerFn(normalizedFnSource) : null;
  const oneshotWorkerFn = usePool ? null : buildOneshotWorkerFn(normalizedFnSource);

  return async function (this: This, ...args: Args): Promise<Awaited<Return>> {
    const state = isStatic ? {} : serializeState(this as object);

    if (usePool) {
      const pool = getOrCreatePool(originalFn, poolWorkerFn!, options!);
      return pool.exec({ __state: state, __args: args }) as Promise<Awaited<Return>>;
    }

    return scatter(oneshotWorkerFn as (ctx: ThreadContext) => Return, {
      data: { __state: state, __args: args },
      timeout: options?.timeout,
      imports: options?.imports as string[] | undefined,
    }) as Promise<Awaited<Return>>;
  };
}

function isStage3MethodDecoratorCall<This, Args extends unknown[], Return>(
  decoratorArgs: unknown[],
): decoratorArgs is [DecoratedMethod<This, Args, Return>, Stage3MethodContext<This, Args, Return>] {
  if (decoratorArgs.length !== 2) return false;
  const [value, context] = decoratorArgs;

  return typeof value === 'function'
    && typeof context === 'object'
    && context !== null
    && 'kind' in context
    && (context as { kind?: unknown }).kind === 'method';
}

function isLegacyMethodDecoratorCall<This, Args extends unknown[], Return>(
  decoratorArgs: unknown[],
): decoratorArgs is [
  object | Function,
  string | symbol,
  TypedPropertyDescriptor<DecoratedMethod<This, Args, Return>>,
] {
  if (decoratorArgs.length !== 3) return false;
  const [target, propertyKey, descriptor] = decoratorArgs;

  return (typeof target === 'object' || typeof target === 'function')
    && (typeof propertyKey === 'string' || typeof propertyKey === 'symbol')
    && typeof descriptor === 'object'
    && descriptor !== null
    && 'value' in descriptor;
}

export function Scaled(options?: ScaledOptions): <This, Args extends unknown[], Return>(
  value: (this: This, ...args: Args) => Return,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
) => (this: This, ...args: Args) => Promise<Awaited<Return>> {
  return function <This, Args extends unknown[], Return>(...decoratorArgs: unknown[]): any {
    if (isStage3MethodDecoratorCall<This, Args, Return>(decoratorArgs)) {
      const [originalFn, context] = decoratorArgs;
      return createScaledMethodWrapper(originalFn, String(context.name), context.static, options);
    }

    if (isLegacyMethodDecoratorCall<This, Args, Return>(decoratorArgs)) {
      const [target, propertyKey, descriptor] = decoratorArgs;
      const originalFn = descriptor.value;

      if (typeof originalFn !== 'function') {
        throw new TypeError(`[scatter] @Scaled can only decorate methods, got ${String(propertyKey)}`);
      }

      descriptor.value = createScaledMethodWrapper(
        originalFn,
        String(propertyKey),
        typeof target === 'function',
        options,
      ) as unknown as DecoratedMethod<This, Args, Return>;
      return descriptor;
    }

    throw new TypeError('[scatter] @Scaled received an unsupported decorator shape');
  };
}
