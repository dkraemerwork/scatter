# Scatter Decorators — Implementation Plan

> **Purpose:** Design and implementation reference for adding `@Scaled()` (method decorator) and
> `@WorkerClass()` (class decorator) to the `scatter` library as an ergonomic sugar layer over
> the existing `scatter.pool()` / `scatter()` runtimes.
>
> **Status:** Planning only — no code written yet.
>
> **Constraint:** ES2025 target, TC39 Stage 3 decorators (no `experimentalDecorators`),
> Bun-only, zero new dependencies.

---

## Table of Contents

1. [Design Decisions](#1-design-decisions)
2. [API Surface](#2-api-surface)
3. [Architecture](#3-architecture)
4. [Implementation Phases](#4-implementation-phases)
5. [File Structure](#5-file-structure)
6. [Test Plan](#6-test-plan)
7. [Edge Cases & Constraints](#7-edge-cases--constraints)

---

## 1. Design Decisions

### Decision 1 — ES Decorators: TC39 Stage 3 only

**Rationale:** `tsconfig.json` uses `"target": "ES2025"` with **no** `experimentalDecorators`
flag. TypeScript 5.0+ defaults to the Stage 3 decorator spec when `experimentalDecorators` is
absent. The implementation MUST use the `(value, context)` two-argument signature, NOT the legacy
`(target, key, descriptor)` signature.

**Impact:** The decorator factories (`Scaled`, `WorkerClass`) are higher-order functions that
return decorator functions conforming to:

```ts
// Method decorator factory signature (Stage 3)
function ScaledDecorator<This, Args extends unknown[], Return>(
  value: (this: This, ...args: Args) => Return,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
): (this: This, ...args: Args) => Promise<Awaited<Return>>

// Class decorator factory signature (Stage 3)
function WorkerClassDecorator<T extends abstract new (...args: unknown[]) => unknown>(
  value: T,
  context: ClassDecoratorContext<T>,
): T
```

Stage 3 decorators can only replace a method with another function, or a class with another
class. They **cannot** change signatures at runtime. The TypeScript type system relies on
overloads and conditional types to express the `Promise<T>` transformation.

---

### Decision 2 — Pool lifecycle: Per-class static pool

**Rationale:** There are three choices for when a pool is created for `@Scaled({ pool: N })`:

| Option | When created | When destroyed | Problem |
|--------|-------------|----------------|---------|
| Per-call | Each invocation | After result | Defeats the purpose of pooling |
| Per-instance | `new MyClass()` | `instance[Symbol.dispose]()` | Pool leak if user forgets |
| **Per-class (static)** | **Lazy (see below)** | **Explicit cleanup** | **Simple, predictable** |

**Decision for `@Scaled`:** Pools are stored in a `WeakMap<Function, ThreadPool>` keyed by
the **original undecorated method function** (captured in the decorator closure). The pool is
created lazily on the **first method call** and shared across all instances of the class.
Cleanup is via `cleanupAllDecoratorPools()` only — `@Scaled` does NOT add `disposeWorkers()`
to the class (see Phase D2 cleanup strategy).

**Decision for `@WorkerClass`:** The pool is stored as a private static field on the
replacement class. It is created lazily on the **first instantiation** (`new MyClass()`),
NOT on the first method call (the constructor needs a pool reference for the Proxy handler).
Cleanup is via `MyClass.disposeWorkers()` (per-class) or `cleanupAllDecoratorPools()` (global).

---

### Decision 3 — State serialization: Structured-clone snapshot of `this`

**Rationale:** Worker functions run in isolated V8 isolates — `this` is not available inside
the worker. For `@Scaled` methods, the instance state at call time is serialized and passed as
`ctx.data.__state`. For `@WorkerClass`, every method call passes the current instance state.

**Rules:**
- Fields are extracted via a shallow `Object.assign({}, this)` pass before the call.
- Non-serializable fields (functions, Symbols, class instances with non-cloneable state,
  WeakMaps, etc.) are silently **dropped** using a safe structured-clone filter.
- **Oneshot mode** (`@Scaled()` without pool): state is passed via `ctx.data.__state`
  (scatter oneshot uses `options.data` → `ctx.data`).
- **Pool mode** (`@Scaled({ pool: N })` and `@WorkerClass`): state is passed via
  `input.__state` (pool tasks use `pool.exec(input)` → second argument to worker fn).
  `ctx.data` in pool mode contains runtime metadata (`__workerIndex`) and is NOT used
  for per-task transport.
- `this` inside the worker function body refers to a reconstructed plain object, NOT the
  original class instance — recursive calls to decorated methods will call the raw function.
- State changes made inside the worker are **NOT reflected back** to the main-thread instance.
  The decorator is stateless/pure in terms of `this`. If return-value-based state sync is
  needed, the user must return the new state explicitly.

**Rationale for no write-back:** Write-back requires knowing which fields changed (diffing),
coordinating with possible concurrent calls, and handling nested objects. The simpler contract —
snapshot-in, result-out — is composable and avoids race conditions.

---

### Decision 4 — Self-recursion in `@Scaled` methods

**Rationale:** The user example shows `this.fibonacci(n - 1)` inside a `@Scaled` method.
Since the worker runs in an isolated V8 scope, `this` is the reconstructed plain object from
Decision 3, not the class instance. `this.fibonacci` will be `undefined`.

**Decision:** For recursive algorithms, the user MUST write the recursive portion as a plain
function and delegate to it. The decorator is documented as **not supporting self-recursive
calls** through the decorated method signature.

**Mitigation:** We provide a clear error message when `this[methodName]` is invoked inside the
worker and we detect that the method is missing (because the plain object doesn't have it).
A dedicated `@ScaledRecursive()` variant is out of scope for this plan.

**For `@WorkerClass`:** Same constraint applies — method-to-method calls inside the worker
body go through the plain object, not the proxy, so they are direct calls (not dispatched to
the pool). This is actually desirable — internal helper methods run inline on the worker thread
without extra round-trips.

---

### Decision 5 — `@WorkerClass` constructor returns a Proxy

**Rationale:** Stage 3 class decorators receive the class constructor and may return a new
class. The replacement class wraps the original, and its constructor returns a `Proxy` that
intercepts method calls.

**Mechanism:**
1. The class decorator creates a pool from the decorated class's methods.
2. The replacement class constructor captures the original constructor and allocates an
   `instanceId` (monotonic counter) for state correlation.
3. Method properties on the prototype are detected, and for each one, the Proxy intercepts
   `get` traps to return an async wrapper function.
4. The proxy target is the actual instance (so `instanceof` still works against the original class).

**TypeScript typing:** Because Stage 3 class decorators can return a new class of the same
interface, we use a utility type `WorkerProxied<T>` that maps all methods `(...args) => R` to
`(...args) => Promise<Awaited<R>>`. The actual TypeScript type transformation is achieved via
declaration merging and a helper type exported alongside the decorator.

---

### Decision 6 — TypeScript return type transformation

**Rationale:** `@Scaled` changes `methodName(args): R` to `methodName(args): Promise<Awaited<R>>`.
TypeScript's Stage 3 method decorators can return a replacement function, but the type checker
only permits returning the **same type** as the original. This means we cannot change the
return type purely via the decorator's return type.

**Decision:** Use two complementary mechanisms:

1. **Runtime:** The decorator returns a function with signature `(...args) => Promise<Awaited<R>>`
   which wraps the original. TypeScript will warn about the type mismatch via strict checking.

2. **Type-level escape hatch:** Export a companion type helper:
   ```ts
   type ScaledMethod<F extends (...args: unknown[]) => unknown> =
     (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>;
   ```
   Users who need precise types on the instance can annotate:
   ```ts
   declare class MathService {
     heavyCompute: ScaledMethod<(n: number) => number>;
   }
   ```

3. **For `@WorkerClass`:** The decorator transforms the return type of the entire class via the
   `WorkerProxied<T>` type alias. Since the decorator replaces the class entirely, users can
   write `const svc: WorkerProxied<MathService> = new MathService()` or use a module augmentation
   to re-declare the class constructor return type.

**Known limitation:** TypeScript Stage 3 decorators currently cannot change the return type of
the decorated value's type. This is a known TypeScript limitation (tracked in microsoft/TypeScript
issues). Users needing full type safety should use the type helper annotations.

---

### Decision 7 — Disposal strategy: `Symbol.dispose` on the class + static method

**Rationale:** Pools created for `@Scaled` methods and `@WorkerClass` classes hold live worker
processes. They must be cleanable.

**Mechanism:**
- `@WorkerClass`: The replacement class gains a **static** `disposeWorkers()` method that
  shuts down the shared pool for that class. The replacement class also implements
  `static [Symbol.asyncDispose]()` which delegates to `disposeWorkers()`, enabling
  `await using` syntax at the class level.
- `@Scaled`: Pools are keyed to the original method function in a module-level WeakMap.
  Individual `@Scaled` methods do NOT add `disposeWorkers()` to the class — cleanup is
  done via the global `cleanupAllDecoratorPools()` export from `scatter/decorators`.
- `cleanupAllDecoratorPools()` shuts down ALL decorator-created pools globally — useful in
  test `afterAll()` hooks or process shutdown handlers.
- `@Scaled` pool references are held in **two** places:
  1. `scaledPools: WeakMap<Function, ThreadPool>` — keyed by originalFn. If the class is GC'd
     and no references to originalFn remain, the WeakMap *entry* is collectible. However, the
     pool object itself is **also** held by the `allDecoratorPools: Set<ThreadPool>` (a strong
     reference). This Set is the true retention root — it prevents the pool from being GC'd
     even if the WeakMap entry is collected.
  2. `allDecoratorPools: Set<ThreadPool>` — strong reference, prevents GC of pools.
  **Consequence:** Pools are NEVER automatically collected or terminated. Workers remain alive
  until explicitly shut down via `cleanupAllDecoratorPools()`. This is by design — worker
  processes cannot be safely terminated by the garbage collector (they may be mid-task).
  Users MUST call `cleanupAllDecoratorPools()` to free resources.

**Symbol.dispose chaining:** The decorator does NOT chain onto an existing `Symbol.dispose`
or `Symbol.asyncDispose` on the user's class. If the user has custom dispose logic, they
must call it themselves alongside `cleanupAllDecoratorPools()` or `MyClass.disposeWorkers()`.
This avoids implicit side effects from decorator composition and keeps the disposal contract
explicit. Chaining may be added in a future version if demand warrants it.

---

### Decision 8 — Serializability filtering

**Rationale:** `this` may contain non-serializable fields. Passing them to `structuredClone()`
or `Bun.serialize()` throws.

**Decision:** Use a safe filter pass before serialization:
```ts
function serializeState(instance: object): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const key of Object.keys(instance)) {
    const val = (instance as Record<string, unknown>)[key];
    if (isSerializable(val)) state[key] = val;
    // else: silently drop (documented behavior)
  }
  return state;
}

function isSerializable(val: unknown): boolean {
  const t = typeof val;
  if (t === 'function' || t === 'symbol' || t === 'undefined') return false;
  if (val instanceof WeakMap || val instanceof WeakSet || val instanceof WeakRef) return false;
  // Attempt structuredClone check for complex objects
  try { structuredClone(val); return true; } catch { return false; }
}
```

The `structuredClone` probe is O(n) in the object graph but only done once per method call.
For hot paths, users can annotate serializable fields explicitly using a future `@Serializable`
field decorator (out of scope here — document as a future enhancement).

---

### Decision 9 — `@Scaled` without options = oneshot mode

**Rationale:** `@Scaled()` with no options should produce the simplest possible behavior: each
call spawns a fresh worker via `scatter()` (oneshot), runs the method body, and returns the
result. This matches the mental model of "run this function on a thread."

`@Scaled({ pool: N })` uses `scatter.pool()` with `size: N`. `@Scaled({ pool: true })` uses
a pool of size `navigator.hardwareConcurrency` (with a `typeof navigator` guard and fallback
to `4`, matching the runtime's defensive pattern).

`@Scaled({ spawn: true })` is explicitly OUT OF SCOPE for v1 — `spawn` mode requires channel
management that doesn't map cleanly to a method call API.

---

### Decision 10 — `@WorkerClass` pool is per-class, shared across instances

**Rationale:** If two `ImageProcessor` instances were each given their own pool, N instances
would create N×pool-size workers, which would quickly saturate CPU. A single shared pool
is efficient and predictable.

**Mechanism:** Pool is stored as a private static field (`#pool`) on the replacement class.
All instances share the same pool. Instance state is passed per-call via `input.__state`
(NOT `ctx.data.__state` — pool tasks use the `input` parameter, not `ctx.data`; see §3.2).

**Pool creation timing:** The pool is created lazily on the **first instantiation**
(`new MyClass()`), NOT on the first method call. The constructor calls `getPool()` to obtain
a pool reference for the Proxy handler. This means `new MyClass()` triggers worker spawning
even if no methods are ever called. This is an acceptable trade-off: instantiation signals
intent to use the class, and deferring pool creation to first method call would add
per-call branching complexity for negligible benefit.

---

## 2. API Surface

### 2.1 `@Scaled()` — Method Decorator

```ts
// src/decorators/scaled.ts

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
 * Method decorator. Offloads the decorated method to a worker thread.
 *
 * The method body is serialized via fn.toString() and executed in a separate
 * V8 isolate. Instance state (this fields) is snapshot-serialized into
 * ctx.data.__state before the call. State changes inside the worker are NOT
 * propagated back to the main-thread instance.
 *
 * IMPORTANT: The decorated method's return type changes to Promise<Awaited<R>>.
 * TypeScript cannot express this type change via the decorator signature alone.
 * Use the ScaledMethod<F> type helper for explicit annotations when needed.
 *
 * @example
 * ```ts
 * class MathService {
 *   @Scaled()
 *   heavyCompute(n: number): number { ... }  // becomes: Promise<number> at runtime
 *
 *   @Scaled({ pool: 4, strategy: 'least-busy' })
 *   fibonacci(n: number): number { ... }
 * }
 *
 * const svc = new MathService();
 * const result = await svc.heavyCompute(1_000_000);
 * ```
 */
export function Scaled(options?: ScaledOptions): <This, Args extends unknown[], Return>(
  value: (this: This, ...args: Args) => Return,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
) => (this: This, ...args: Args) => Promise<Awaited<Return>>;

/**
 * Type helper to annotate the correct post-decoration return type.
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
```

---

### 2.2 `@WorkerClass()` — Class Decorator

```ts
// src/decorators/worker-class.ts

/** Options for @WorkerClass() */
export interface WorkerClassOptions {
  /**
   * Pool size for the class's workers.
   * - `number`: exact pool size (must be >= 1, positive integer; throws TypeError if invalid)
   * - `true` / omitted: auto-detect via navigator.hardwareConcurrency (fallback: 4)
   * - `false`: NOT VALID — @WorkerClass always uses a pool. Passing `false` throws TypeError.
   *
   * NOTE: Unlike @Scaled (which defaults to oneshot when pool is omitted), @WorkerClass
   * ALWAYS creates a pool because the class decorator dispatches ALL methods to workers.
   * There is no "oneshot" mode for @WorkerClass.
   *
   * @default auto (navigator.hardwareConcurrency ?? 4)
   */
  readonly pool?: number | boolean;

  /**
   * Per-worker concurrency.
   * @default 1
   */
  readonly concurrency?: number;

  /**
   * Dispatch strategy.
   * @default 'round-robin'
   */
  readonly strategy?: 'round-robin' | 'least-busy';

  /**
   * Additional imports to inject into all workers.
   */
  readonly imports?: readonly string[];

  /**
   * Maximum queue size for the pool.
   * When the queue is full, exec() rejects.
   * @default Infinity (unbounded — matches scatter.pool() default)
   */
  readonly maxQueue?: number;
}

/**
 * Class decorator. Makes ALL methods in the class run in a worker pool.
 *
 * The constructor returns a Proxy that intercepts all method calls. Each call
 * dispatches to the pool, passing the serialized instance state as ctx.data.__state.
 *
 * All methods on the decorated class become async (return Promise<T>).
 * Methods prefixed with _ (private convention) are NOT proxied.
 *
 * The class gains a static `disposeWorkers()` method for pool cleanup.
 *
 * @example
 * ```ts
 * @WorkerClass({ pool: 2 })
 * class ImageProcessor {
 *   resize(img: Uint8Array, w: number, h: number): Uint8Array { ... }
 *   blur(img: Uint8Array, radius: number): Uint8Array { ... }
 * }
 *
 * const proc = new ImageProcessor();
 * const resized = await proc.resize(img, 800, 600);
 * await ImageProcessor.disposeWorkers();
 * ```
 */
export function WorkerClass(options?: WorkerClassOptions): <
  T extends abstract new (...args: unknown[]) => unknown,
>(
  value: T,
  context: ClassDecoratorContext<T>,
) => T;

/**
 * Type alias that maps all methods of a class instance to their async equivalents.
 *
 * NOTE: `disposeWorkers()` is a STATIC method on the class constructor, NOT on
 * instances. Call `MyClass.disposeWorkers()`, not `instance.disposeWorkers()`.
 * This type intentionally does NOT include `disposeWorkers` — use the separate
 * `WorkerClassStatic<T>` type for the constructor side.
 *
 * @example
 * ```ts
 * const proc: WorkerProxied<ImageProcessor> = new ImageProcessor();
 * await proc.resize(img, 800, 600);         // OK — proxied
 * await ImageProcessor.disposeWorkers();     // OK — static cleanup
 * // proc.disposeWorkers() — NOT available (correctly)
 * ```
 */
export type WorkerProxied<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K];
};

/**
 * Type alias for the static side of a @WorkerClass-decorated class.
 * Adds the `disposeWorkers()` static method to the constructor type.
 *
 * @example
 * ```ts
 * const ProcessorClass: WorkerClassStatic<typeof ImageProcessor> = ImageProcessor;
 * await ProcessorClass.disposeWorkers();
 * ```
 */
export type WorkerClassStatic<T extends abstract new (...args: unknown[]) => unknown> = T & {
  disposeWorkers(): Promise<void>;
};
```

---

### 2.3 Utility exports

```ts
// src/decorators/index.ts

export { Scaled } from './scaled.js';
export type { ScaledOptions, ScaledMethod } from './scaled.js';

export { WorkerClass } from './worker-class.js';
export type { WorkerClassOptions, WorkerProxied, WorkerClassStatic } from './worker-class.js';

/**
 * Gracefully shut down ALL pools created by @Scaled and @WorkerClass decorators.
 * Useful in test cleanup (afterAll) or process shutdown handlers.
 *
 * Behavior:
 * - Calls shutdown() (graceful drain + terminate) on every tracked pool.
 * - Uses best-effort semantics: if one pool's shutdown fails, the others
 *   still attempt to shut down. All errors are collected and thrown as a
 *   single AggregateError after all pools have been processed.
 * - Race-safe: pools created DURING shutdown (e.g., a lazy-init method call
 *   triggers pool creation while cleanup is running) remain tracked and are
 *   NOT silently lost. Only the snapshot of pools taken at call time are shut
 *   down and removed from the tracking set.
 * - Safe to call multiple times — second call processes any pools created
 *   since the previous call. No-op if no new pools exist.
 */
export async function cleanupAllDecoratorPools(): Promise<void> {
  // Snapshot the current pools, but do NOT clear yet — if new pools are created
  // during shutdown (e.g., a method call triggers lazy pool init), they will be
  // added to allDecoratorPools and caught by the post-shutdown clear.
  const pools = [...allDecoratorPools];

  const errors: Error[] = [];
  await Promise.allSettled(
    pools.map(async (pool) => {
      try {
        await pool.shutdown();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }),
  );

  // Clear AFTER all shutdowns complete — this ensures any pools created
  // during the shutdown window are still tracked. If a new pool was created
  // between the snapshot and this clear, it will be removed from the set.
  // The next cleanupAllDecoratorPools() call will handle it if needed.
  // NOTE: We clear the snapshot entries specifically, not the whole set,
  // so pools created during shutdown remain tracked.
  for (const pool of pools) {
    allDecoratorPools.delete(pool);
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `[scatter] ${errors.length} pool(s) failed to shut down cleanly`,
    );
  }
}
```

---

### 2.4 Package entry point addition

```jsonc
// package.json exports — add alongside existing entries
{
  "exports": {
    ".": { "import": "./src/index.ts", "types": "./src/index.ts" },
    "./decorators": {
      "import": "./src/decorators/index.ts",
      "types": "./src/decorators/index.ts"
    }
  }
}
```

The decorators are exported from a **separate entry point** (`scatter/decorators`) to keep the
core library zero-overhead for users who don't need the decorator API. No decorator code is
imported by `src/index.ts`.

---

## 3. Architecture

### 3.1 How `@Scaled` uses existing scatter internals

```
@Scaled() ─────────────────────────────────────────────────────────────
                                                                        │
  At decoration time (class body evaluation):                           │
    normalizedFnSource = normalizeMethodSource(originalFn.toString())   │
    if (poolMode)                                                       │
      poolWorkerFn = buildPoolWorkerFn(normalizedFnSource)              │
    else                                                                │
      oneshotWorkerFn = buildOneshotWorkerFn(normalizedFnSource)        │
                                                                        │
  returns replacement function:                                         │
    async function scaledWrapper(this, ...args) {                       │
      const state = context.static                                      │
        ? {}                         // static methods → no state       │
        : serializeState(this)       // instance → snapshot this        │
                                                                        │
      if (poolMode) {                                                   │
        const pool = getOrCreatePool(originalFn, poolWorkerFn, opts)    │
        return pool.exec({ __state: state, __args: args })              │
      } else {                                                          │
        return scatter(oneshotWorkerFn, {                               │
          data: { __state: state, __args: args },                       │
          timeout, imports                                              │
        })                                                              │
      }                                                                 │
    }                                                                   │
```

The key insight: the **worker function** is constructed by wrapping `originalFn.toString()`
inside a scaffold that:
1. Reconstructs a plain object from the state payload:
   - Oneshot: `ctx.data.__state` (data passed via `scatter(fn, { data })` → `ctx.data`)
   - Pool: `input.__state` (data passed via `pool.exec(input)` → second argument)
2. Calls the original function body with `self` bound as `this`
3. Returns the result

This is done via the `build-worker-fn` module's helpers (described in §3.3).

---

### 3.2 How `@WorkerClass` uses existing scatter internals

```
@WorkerClass() ────────────────────────────────────────────────────────
                                                                        │
  Stage 1: Decorator returns a new class                               │
    class WorkerProxyClass extends OriginalClass {                     │
      static readonly #pool: ThreadPool                                │
      static disposeWorkers(): Promise<void> { ... }                   │
                                                                        │
      constructor(...args) {                                            │
        super(...args)                                                  │
        return new Proxy(this, proxyHandler)   // intercept all calls  │
      }                                                                 │
    }                                                                   │
                                                                        │
  Stage 2: proxyHandler.get(target, methodName) →                     │
    async function proxiedMethod(...args) {                            │
      const state = serializeState(target)                             │
      return pool.exec({ __method: methodName, __args: args, __state: state })
    }                                                                   │
                                                                        │
  Stage 3: Pool worker function receives:                              │
    { __method, __args, __state }                                      │
                                                                        │
    Worker reconstructs the class instance:                            │
      const instance = Object.assign(new OriginalClass(), state)       │
    Calls: instance[__method](...__args)                               │
    Returns result                                                      │
```

The pool worker function is a **single generic dispatcher** generated from the class at
decoration time. It holds the class source (via `.toString()` of the constructor) and all
method sources, then at runtime reconstructs the class and dispatches the call.

---

### 3.3 `build-worker-fn` — The core adapter module

This module is the critical piece that bridges decorator calls to the scatter runtime. It
contains four functions:

1. **`normalizeMethodSource(fnSource)`** — converts method shorthands (regular, async,
   generator, async generator) to valid function declarations
2. **`buildWorkerFnSource(normalizedFnSource)`** — generates a worker function source string
   that embeds the original function and calls it with reconstructed `this` and deserialized args
3. **`buildOneshotWorkerFn(normalizedFnSource)`** — wraps the source into a real `Function`
   for `scatter()` oneshot mode (`(ctx) => result`)
4. **`buildPoolWorkerFn(normalizedFnSource)`** — wraps the source into a real `Function`
   for `scatter.pool()` mode (`(ctx, input) => result`)

The approach is **source-level composition**: instead of passing `originalFn` directly
to scatter, we construct a NEW `Function` whose source string embeds `originalFn.toString()`
(after normalization) and calls it. Since scatter calls `fn.toString()` on the worker function,
it gets the generated wrapper — which correctly embeds the original method source.

The worker function is a wrapper that:
1. Reads `__state` to reconstruct `this` as a plain object
2. Reads `__args` for the call arguments
3. Calls the original function body with reconstructed `this`
4. Returns the result

Worker functions run in isolated V8 scope — there is no eval-injection risk from user code
that could escape the worker boundary. The `new Function()` constructor is used only at
decoration time (once per method), not per call.

---

### 3.4 State flow diagram

```
Main Thread                                    Worker Thread
─────────────────────────────────────────      ─────────────────────────────────────────
                                               
class MathService {                            
  @Scaled({ pool: 4 })                         
  compute(n) { return n * this.multiplier }    
}                                              
const svc = new MathService()                  
svc.multiplier = 7  // instance state          
                                               
await svc.compute(6)                           
    │                                          
    ▼                                          
serializeState(svc)                            
  → { multiplier: 7 }          serialized      
                                  ──────►     ctx.data = {
                                                __state: { multiplier: 7 },
                                                __args: [6]
                                              }
                                               ┌─────────────────────────────┐
                                               │ const self = { multiplier:7}│
                                               │ originalFn.call(self, 6)    │
                                               │ → 6 * 7 = 42               │
                                               └─────────────────────────────┘
    │                             result
    ◄─────────────────────────────────────  42
    │
    ▼
Promise resolves with 42
```

---

### 3.5 Pool lifecycle diagrams

**`@Scaled({ pool: N })` lifecycle:**

```
Class definition time:
  @Scaled({ pool: 4 }) on MathService.fibonacci
  → decorator captures originalFn reference and builds poolWorkerFn
  → NO pool created yet (lazy init)

First method call (from any instance):
  → getOrCreatePool() checks scaledPools WeakMap — miss
  → scatter.pool(poolWorkerFn, { size: 4 }) called (SYNC — returns immediately)
  → 4 worker processes spawned
  → pool stored in scaledPools.set(originalFibFn, pool)
  → pool added to allDecoratorPools tracking set

Subsequent calls from ANY instance:
  → getOrCreatePool() checks scaledPools — hit, returns existing pool
  → pool.exec({ __state, __args }) dispatches to worker

Cleanup:
  → cleanupAllDecoratorPools()     // primary: shuts down ALL @Scaled pools
  → (scaledPools is NOT exported — no per-method cleanup from user code)
```

**`@WorkerClass({ pool: N })` lifecycle:**

```
Class definition time:
  @WorkerClass({ pool: 2 }) on ImageProcessor
  → decorator collects method names, builds class dispatcher source
  → Returns replacement class with static #pool = null (lazy init)
  → NO pool created yet

First instantiation (new ImageProcessor()):
  → constructor calls ReplacementClass.getPool()
  → getPool() checks #pool — null → creates pool
  → scatter.pool(dispatcherFn, { size: 2 }) called (SYNC)
  → 2 worker processes spawned
  → pool stored in static #pool, added to allDecoratorPools
  → constructor returns Proxy(this, proxyHandler)

Subsequent instantiations:
  → constructor calls getPool() — #pool already set, returns existing pool
  → new Proxy created, but shares same pool

All method calls from ANY instance:
  → Proxy intercepts → pool.exec({ __method, __state, __args })

Cleanup:
  → ImageProcessor.disposeWorkers()  // per-class: shuts down this class's pool
  → cleanupAllDecoratorPools()       // global: shuts down ALL decorator pools
```

---

### 3.6 Integration with existing runtime

The decorator layer is a **pure consumer** of the existing scatter runtime API. It calls:
- `scatter(fn, opts)` — for oneshot `@Scaled()`
- `scatter.pool(fn, opts)` — for pooled `@Scaled({ pool: N })` and `@WorkerClass`

It does NOT modify any existing files. All new code lives in `src/decorators/`.

The only change to existing files: adding the `./decorators` entry to `package.json`.

---

## 4. Implementation Phases

### Phase D1: Foundation — `serializeState` and `build-worker-fn`

**Depends on:** Nothing (pure utility functions, no scatter imports needed)
**Files:** `src/decorators/serialize-state.ts`, `src/decorators/build-worker-fn.ts`

| Task | Description |
|------|-------------|
| D1.1 | Create `src/decorators/` directory |
| D1.2 | Implement `serializeState(instance: object): Record<string, unknown>` — extracts own enumerable properties, filters out non-serializable values via `isSerializable()` check |
| D1.3 | Implement `isSerializable(val: unknown): boolean` — rejects functions, symbols, WeakMaps, etc; uses `try { structuredClone(val); return true } catch { return false }` as final check |
| D1.4 | Implement `normalizeMethodSource(fnSource: string): string` — handles regular, async, generator, and async generator method shorthands (see §3.3) |
| D1.5 | Implement `buildWorkerFnSource(originalFnSource: string): string` — generates the worker function source string that embeds the original function and calls it with reconstructed `this` and deserialized args |
| D1.6 | Implement `buildOneshotWorkerFn(normalizedFnSource: string): Function` — wraps `buildWorkerFnSource` output into a real `Function` for scatter() oneshot mode |
| D1.7 | Implement `buildPoolWorkerFn(normalizedFnSource: string): Function` — wraps source into a real `Function` for scatter.pool() with `(ctx, input)` signature |
| D1.8 | Write unit tests for `serializeState` covering: plain objects, nested objects, functions (dropped), symbols (dropped), WeakMaps (dropped), class instances with mixed fields, circular references (dropped) |
| D1.9 | Write unit tests for `normalizeMethodSource` covering: regular, async, generator, async generator methods, arrow functions, and already-prefixed functions |
| D1.10 | Write unit tests for `buildWorkerFnSource`, `buildOneshotWorkerFn`, `buildPoolWorkerFn` covering: correct source generation, args passed correctly, this bound to state object, callable function output |

**`buildWorkerFnSource` sketch:**

```ts
function buildWorkerFnSource(originalFnSource: string): string {
  // Generate source code for a function that:
  // 1. Reads __state and __args from ctx.data
  // 2. Calls the original function with reconstructed this
  //
  // The originalFnSource is a method body, e.g.:
  //   "function compute(n) { return n * this.multiplier; }"
  //
  // We wrap it as:
  //   function __originalMethod(...) { ... }   // the original source
  //   const __self = Object.assign({}, ctx.data.__state ?? {});
  //   const __args = ctx.data.__args ?? [];
  //   return __originalMethod.apply(__self, __args);
  //
  // This is injected into the scatter worker function body at call time.
  return `
    const __originalFn = ${originalFnSource};
    const __self = Object.assign({}, ctx.data.__state ?? {});
    const __callArgs = ctx.data.__args ?? [];
    return __originalFn.apply(__self, __callArgs);
  `;
}
```

However, this approach has a subtlety: `originalFnSource` for a class method is typically
`methodName(args) { body }` (without the `function` keyword). We must handle ALL forms:

- Regular method: `compute(n) { ... }` → `function compute(n) { ... }`
- Async method: `async compute(n) { ... }` → `async function compute(n) { ... }`
- Generator method: `*generate(n) { ... }` → `function* generate(n) { ... }`
- Async generator: `async *stream(n) { ... }` → `async function* stream(n) { ... }`

```ts
function normalizeMethodSource(fnSource: string): string {
  const trimmed = fnSource.trimStart();

  // Already a function expression/declaration or arrow: pass through
  if (trimmed.startsWith('function') || trimmed.includes('=>')) return fnSource;

  // Async generator method: "async *name(...) { ... }" → "async function* name(...) { ... }"
  if (trimmed.startsWith('async') && trimmed.slice(5).trimStart().startsWith('*')) {
    const afterAsync = trimmed.slice(5).trimStart();    // "*name(...) { ... }"
    const afterStar = afterAsync.slice(1).trimStart();  // "name(...) { ... }"
    return `async function* ${afterStar}`;
  }

  // Async method: "async name(...) { ... }" → "async function name(...) { ... }"
  if (trimmed.startsWith('async')) {
    const afterAsync = trimmed.slice(5).trimStart();  // "name(...) { ... }"
    return `async function ${afterAsync}`;
  }

  // Generator method: "*name(...) { ... }" → "function* name(...) { ... }"
  if (trimmed.startsWith('*')) {
    const afterStar = trimmed.slice(1).trimStart();  // "name(...) { ... }"
    return `function* ${afterStar}`;
  }

  // Regular method shorthand: "name(...args) { body }" → "function name(...args) { body }"
  return `function ${trimmed}`;
}
```

**IMPORTANT:** The ordering of checks matters — `async *` must be checked before bare `async`,
and `*` before the default case. Each branch produces valid JavaScript for the corresponding
method kind.

**Critical:** The worker function passed to `scatter()` must be a REAL function at the main-thread
call site — scatter calls `fn.toString()` on it. So we construct a dynamic function at decoration
time using the `Function` constructor with the generated source as body. This is safe in this
context since it runs in the main thread only during the scatter setup phase.

The `new Function` constructor creates a function whose `.toString()` returns the generated
wrapper source. When scatter calls `fn.toString()` on it, it gets the wrapper, which correctly
embeds the original method source. This is the correct approach.

The actual construction is done via two named helpers (called ONCE per decoration, not per call):

**Helper constructors for oneshot and pool worker functions:**

Both modes need a concrete `Function` object whose `.toString()` will be consumed by the
scatter runtime. We define two named helpers — `buildOneshotWorkerFn` and `buildPoolWorkerFn` —
that wrap `buildWorkerFnSource` output into real `Function` instances:

```ts
// src/decorators/build-worker-fn.ts

import type { ThreadContext } from '../context.js';
import type { PoolWorkerContext } from '../runtime/scatter-pool.js';

/**
 * State + args payload for @Scaled oneshot and pool mode.
 * Used by buildOneshotWorkerFn and buildPoolWorkerFn.
 */
interface WorkerPayload {
  readonly __state: Record<string, unknown>;
  readonly __args: unknown[];
}

/**
 * Dispatch payload for @WorkerClass pool mode.
 * Extends WorkerPayload with the method name to invoke.
 */
interface ClassDispatchPayload extends WorkerPayload {
  readonly __method: string;
}

/**
 * Build a oneshot worker function for scatter().
 *
 * Returns a real Function whose .toString() embeds the original method source.
 * scatter() calls fn.toString() internally — the generated source includes the
 * state reconstruction and method invocation scaffold.
 *
 * NOTE: The generated wrapper is intentionally NOT async. If the original method
 * is async, `__originalFn.apply(...)` returns a Promise, and the wrapper returns
 * that Promise directly. The scatter scaffold does `await __fn(ctx)`, which
 * correctly awaits the returned Promise. Making the wrapper async would add an
 * unnecessary extra microtask tick.
 *
 * @param normalizedFnSource - Output of normalizeMethodSource(originalFn.toString())
 */
function buildOneshotWorkerFn(
  normalizedFnSource: string,
): (ctx: ThreadContext) => unknown {
  return new Function(
    'ctx',
    `
      const __originalFn = ${normalizedFnSource};
      const __self = Object.assign({}, ctx.data.__state ?? {});
      const __callArgs = ctx.data.__args ?? [];
      return __originalFn.apply(__self, __callArgs);
    `,
  ) as (ctx: ThreadContext) => unknown;
}

/**
 * Build a pool worker function for scatter.pool().
 *
 * Pool workers receive (ctx, input) where input is the WorkerPayload
 * passed via pool.exec(). The generated function reconstructs `this` from
 * input.__state and calls the original method with input.__args.
 *
 * @param normalizedFnSource - Output of normalizeMethodSource(originalFn.toString())
 */
function buildPoolWorkerFn(
  normalizedFnSource: string,
): (ctx: PoolWorkerContext, input: WorkerPayload) => unknown {
  return new Function(
    'ctx',
    'input',
    `
      const __originalFn = ${normalizedFnSource};
      const __self = Object.assign({}, input.__state ?? {});
      return __originalFn.apply(__self, input.__args ?? []);
    `,
  ) as (ctx: PoolWorkerContext, input: WorkerPayload) => unknown;
}
```

These are called from Phase D2 (`@Scaled`) and referenced from Phase D3 (`@WorkerClass`
uses the class dispatcher variant instead). They are defined in `build-worker-fn.ts` alongside
`buildWorkerFnSource` and `normalizeMethodSource`.

**Exit criteria:** `serializeState`, `buildWorkerFnSource`, `buildOneshotWorkerFn`, and
`buildPoolWorkerFn` all pass unit tests.

---

### Phase D2: `@Scaled` decorator

**Depends on:** Phase D1, scatter runtime (scatter() and scatter.pool() must be implemented)
**Files:** `src/decorators/scaled.ts`

| Task | Description |
|------|-------------|
| D2.1 | Create `src/decorators/scaled.ts` |
| D2.2 | Define `ScaledOptions` interface |
| D2.3 | Create module-level `scaledPools: WeakMap<Function, ThreadPool>` registry. **Key identity:** In TC39 Stage 3 decorators, the `value` parameter passed to a method decorator is the method's function object. Each class definition produces a unique function reference per method — two different classes defining `compute()` get different function objects. This guarantees separate WeakMap entries (and thus separate pools) per class per method. |
| D2.4 | Create module-level `allDecoratorPools: Set<ThreadPool>` for global cleanup |
| D2.5 | Implement `Scaled(options?)` decorator factory with TC39 Stage 3 signature |
| D2.6 | Implement lazy pool creation via `getOrCreatePool()` — pool is NOT created at decoration time, only on first method call. No `addInitializer` needed for pool init. |
| D2.7 | Return replacement method that: (a) serializes `this`, (b) calls `scatter()` or `pool.exec()`, (c) passes `{ __state, __args }` as data/input |
| D2.8 | Verify `@Scaled` pools are tracked in `allDecoratorPools` for `cleanupAllDecoratorPools()` |
| D2.9 | Implement `ScaledMethod<F>` type helper |

**Pool init timing — lazy creation:**

Pools are NOT created eagerly at decoration time or class evaluation time. Importing a module
should not spawn workers as a side effect, and the user may never call the decorated method.

**Solution:** Lazy pool creation — the pool is created on first call inside the replacement
method. The `getOrCreatePool` function uses the `scaledPools` WeakMap as the once-guard:

```ts
/**
 * Lazily create or retrieve a pool for the given original method function.
 *
 * IMPORTANT ASSUMPTION: scatter.pool() is SYNCHRONOUS — it returns a ThreadPool
 * immediately without yielding to the event loop. This guarantees that the
 * has() → set() sequence below cannot interleave between concurrent callers
 * within a single event loop tick. If scatter.pool() ever becomes async, this
 * function MUST be updated to use a synchronization guard (e.g., a pending
 * Promise stored in the map).
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

  // Validate pool size — must be a positive integer.
  // Matches the scatter.pool() runtime validation (throws TypeError on invalid size).
  // We throw here to give a decorator-specific error message and fail fast,
  // rather than letting scatter.pool() throw with a confusing stack trace.
  if (typeof rawPoolSize !== 'number' || rawPoolSize < 1 || !Number.isInteger(rawPoolSize)) {
    throw new TypeError(
      `[scatter] @Scaled: pool size must be a positive integer, got ${rawPoolSize}`,
    );
  }

  // Validate concurrency — must be a positive integer (matches scatter.pool() runtime check).
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
    imports: options.imports,
    ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
  });

  scaledPools.set(originalFn, pool);
  allDecoratorPools.add(pool);
  return pool;
}
```

**Stage 3 decorator implementation sketch:**

```ts
export function Scaled(options?: ScaledOptions) {
  return function <This, Args extends unknown[], Return>(
    originalFn: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
  ): (this: This, ...args: Args) => Promise<Awaited<Return>> {

    const normalizedFnSource = normalizeMethodSource(originalFn.toString());
    const usePool = !!(options?.pool);
    
    // Warn at decoration time if incompatible options are combined.
    // This runs once per decorated method, not per call.
    if (usePool && options?.timeout !== undefined) {
      console.warn(
        `[scatter] @Scaled on '${String(context.name)}': timeout option is ignored in pool mode. ` +
        `Use scatter.pool() directly for per-task timeouts.`,
      );
    }

    let poolWorkerFn: Function | null = null;
    let oneshotWorkerFn: Function | null = null;
    
    if (usePool) {
      // Build pool worker fn once (evaluated at decoration time)
      poolWorkerFn = buildPoolWorkerFn(normalizedFnSource);
    } else {
      // Build oneshot worker fn once
      oneshotWorkerFn = buildOneshotWorkerFn(normalizedFnSource);
    }

    // NOTE: We do NOT use context.addInitializer for pool creation or disposal.
    // For instance method decorators, addInitializer runs with 'this' bound to
    // the new instance — not useful for static disposal registration.
    // Instead, all @Scaled pools are cleaned up via cleanupAllDecoratorPools().

    // Return the replacement method
    return async function (this: This, ...args: Args): Promise<Awaited<Return>> {
      // For static methods, skip state serialization — 'this' is the constructor
      const state = context.static ? {} : serializeState(this as object);

      if (usePool) {
        const pool = getOrCreatePool(originalFn, poolWorkerFn!, options!);
        return pool.exec({ __state: state, __args: args }) as Promise<Awaited<Return>>;
      } else {
        return scatter(oneshotWorkerFn as (ctx: ThreadContext) => Return, {
          data: { __state: state, __args: args },
          timeout: options?.timeout,
          imports: options?.imports,
        }) as Promise<Awaited<Return>>;
      }
    };
  };
}
```

**Cleanup strategy for `@Scaled`:**

`@Scaled` does NOT add a static `disposeWorkers()` to the class — mutating a class from a
method decorator is fragile and doesn't compose well when multiple methods are decorated.
Instead, `@Scaled` cleanup is done exclusively through `cleanupAllDecoratorPools()`:

- The internal `scaledPools` WeakMap is NOT exported — users cannot access it directly.
- Per-method cleanup is intentionally not supported in v1.
- The recommended pattern is `afterAll(() => cleanupAllDecoratorPools())` in test teardown.

For `@WorkerClass`, per-class cleanup IS available via the static `MyClass.disposeWorkers()`
method added by the decorator (see Phase D3).

**Exit criteria:** `@Scaled()` and `@Scaled({ pool: N })` work in basic tests.

---

### Phase D3: `@WorkerClass` decorator

**Depends on:** Phase D1, scatter runtime
**Files:** `src/decorators/worker-class.ts`

| Task | Description |
|------|-------------|
| D3.1 | Create `src/decorators/worker-class.ts` |
| D3.2 | Define `WorkerClassOptions` interface |
| D3.3 | Implement `WorkerClass(options?)` class decorator factory |
| D3.4 | Build the generic dispatcher worker function from the class's methods |
| D3.5 | Create pool via `scatter.pool()`, store as static on the replacement class |
| D3.6 | Implement Proxy handler that intercepts method calls |
| D3.7 | Implement static `disposeWorkers()` on the replacement class |
| D3.8 | Implement `WorkerProxied<T>` type alias |
| D3.9 | Handle `_private` method convention (not proxied) |
| D3.10 | Handle symbol-keyed methods (not proxied) |

**Critical implementation detail — the class dispatcher:**

For `@WorkerClass`, all methods share a single pool. The pool's worker function is a
**generic dispatcher** that must know about all methods. We generate it at decoration time:

```ts
function buildClassDispatcherSource(
  OriginalClass: Function,
  methodNames: string[],
): string {
  // Collect method sources, filtering out any entries that aren't functions.
  // This should not happen (the caller already filters), but defensive code
  // must produce valid JavaScript — never an empty string in object literal position.
  const validMethods: { name: string; source: string }[] = [];
  for (const name of methodNames) {
    const method = (OriginalClass.prototype as Record<string, unknown>)[name];
    if (typeof method !== 'function') continue; // skip — do NOT produce empty source
    validMethods.push({ name, source: normalizeMethodSource(method.toString()) });
  }

  // Generate a dispatcher that:
  // 1. Reconstitutes a plain object with all original method sources defined
  // 2. Dispatches to the requested method with the provided args and state
  // 3. Guards against state fields shadowing methods (H4 fix)
  return `
    // Method implementations (inlined from class source)
    const __methods = {
      ${validMethods.map(({ name, source }) => `${name}: ${source}`).join(',\n')}
    };

    // Reconstruct instance-like object: methods on prototype, state as own properties.
    // IMPORTANT: State fields that collide with method names are DROPPED to prevent
    // shadowing. If this.compute = 42 and there's a method named compute(), the state
    // field is excluded so this.compute(...) still calls the method.
    const __state = input.__state ?? {};
    const __safeState = {};
    for (const __key of Object.keys(__state)) {
      if (!(__key in __methods)) __safeState[__key] = __state[__key];
    }
    const __self = Object.assign(Object.create(__methods), __safeState);

    // Dispatch
    const __method = __methods[input.__method];
    if (!__method) throw new Error('[scatter] @WorkerClass: unknown method: ' + input.__method);
    return __method.apply(__self, input.__args ?? []);
  `;
}
```

**Key insight:** By creating a plain object that has the original methods as own properties
(via `Object.create(__methods)`), `this.otherMethod(...)` calls inside the worker will work
correctly — they dispatch to the local copy of the method, not back through the proxy. This
elegantly handles method-to-method calls within the class body.

**Proxy handler implementation:**

```ts
function createProxyHandler(
  pool: ThreadPool<unknown, unknown>,
  methodNames: Set<string>,
): ProxyHandler<object> {
  return {
    get(target, prop, receiver) {
      // Pass through non-method properties and special symbols
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      // _prefixed methods are NOT proxied — execute on main thread (see §7.9)
      if (prop.startsWith('_')) return Reflect.get(target, prop, receiver);
      // Non-method properties (fields, getters, etc.) pass through
      if (!methodNames.has(prop)) return Reflect.get(target, prop, receiver);
      // NOTE: disposeWorkers is a STATIC method on the class constructor, not on
      // instances. It is never in methodNames (which only has prototype methods),
      // so no special check is needed here.

      // Return an async wrapper for the method
      return async function (this: object, ...args: unknown[]) {
        const state = serializeState(target);
        return pool.exec({ __method: prop, __args: args, __state: state });
      };
    },
  };
}
```

**Stage 3 class decorator implementation sketch:**

```ts
export function WorkerClass(options?: WorkerClassOptions) {
  return function <T extends abstract new (...args: unknown[]) => unknown>(
    OriginalClass: T,
    context: ClassDecoratorContext<T>,
  ): T {
    // Collect all non-private prototype method names (own properties only).
    // Uses property descriptors to correctly exclude getters/setters (§7.3).
    // Only own prototype methods are included — inherited methods are NOT proxied (§7.4).
    const methodNames = new Set<string>();
    for (const name of Object.getOwnPropertyNames(OriginalClass.prototype)) {
      if (name === 'constructor') continue;
      if (name.startsWith('_')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(OriginalClass.prototype, name);
      if (!descriptor || typeof descriptor.value !== 'function') continue;
      methodNames.add(name);
    }

    // Build the generic pool worker function source
    const dispatcherSource = buildClassDispatcherSource(OriginalClass, [...methodNames]);
    const poolWorkerFn = new Function(
      'ctx',
      'input',
      dispatcherSource,
    ) as (ctx: PoolWorkerContext, input: ClassDispatchPayload) => unknown;

    // Validate pool option — @WorkerClass always uses a pool, false is not valid.
    if (options?.pool === false) {
      throw new TypeError(
        `[scatter] @WorkerClass: pool: false is not valid. ` +
        `@WorkerClass always uses a pool. Omit the option for auto-detect or pass a number.`,
      );
    }

    // Use the same defensive navigator guard as the scatter runtime
    const rawPoolSize =
      options?.pool === true || options?.pool === undefined
        ? ((typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) ?? 4)
        : options.pool;

    // Validate pool size — must be a positive integer.
    // Matches @Scaled and scatter.pool() runtime validation (throws TypeError).
    if (typeof rawPoolSize !== 'number' || rawPoolSize < 1 || !Number.isInteger(rawPoolSize)) {
      throw new TypeError(
        `[scatter] @WorkerClass: pool size must be a positive integer, got ${rawPoolSize}`,
      );
    }

    // Validate concurrency — must be a positive integer (matches scatter.pool() runtime check).
    const concurrency = options?.concurrency ?? 1;
    if (typeof concurrency !== 'number' || concurrency < 1 || !Number.isInteger(concurrency)) {
      throw new TypeError(
        `[scatter] @WorkerClass: concurrency must be a positive integer, got ${concurrency}`,
      );
    }

    // The replacement class
    const ReplacementClass = class extends (OriginalClass as new (...args: unknown[]) => object) {
      // Pool is created lazily on first instantiation
      static #pool: ThreadPool<unknown, unknown> | null = null;

      static getPool(): ThreadPool<unknown, unknown> {
        if (!this.#pool) {
          this.#pool = scatter.pool(poolWorkerFn, {
            size: rawPoolSize,
            concurrency,
            strategy: options?.strategy ?? 'round-robin',
            imports: options?.imports,
            ...(options?.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
          });
          allDecoratorPools.add(this.#pool);
        }
        return this.#pool;
      }

      /**
       * Gracefully shut down the worker pool for this class.
       *
       * Uses shutdown() (graceful: drains pending tasks, then terminates) rather
       * than terminate() (immediate: kills workers mid-task) because decorator
       * users cannot easily distinguish "safe to kill" vs "task in flight" states.
       * Graceful shutdown is the safer default — users who need immediate kill
       * can call scatter.pool() directly.
       */
      static async disposeWorkers(): Promise<void> {
        if (this.#pool) {
          await this.#pool.shutdown();
          allDecoratorPools.delete(this.#pool);
          this.#pool = null;
        }
      }

      static [Symbol.asyncDispose](): Promise<void> {
        return this.disposeWorkers();
      }

      constructor(...args: unknown[]) {
        super(...args);
        const pool = ReplacementClass.getPool();
        return new Proxy(this, createProxyHandler(pool, methodNames));
      }
    };

    return ReplacementClass as unknown as T;
  };
}
```

**Exit criteria:** `@WorkerClass({ pool: 2 })` creates a pooled class where all methods
are proxied through workers.

---

### Phase D4: Index and entry point wiring

**Depends on:** Phase D2, D3
**Files:** `src/decorators/index.ts`, `package.json`

| Task | Description |
|------|-------------|
| D4.1 | Create `src/decorators/index.ts` with all exports |
| D4.2 | Implement `cleanupAllDecoratorPools(): Promise<void>` |
| D4.3 | Add `./decorators` to `package.json` exports map |
| D4.4 | Verify TypeScript compiles with zero errors: `bun run tsc --noEmit` |

**Exit criteria:** `import { Scaled, WorkerClass } from 'scatter/decorators'` works.

---

### Phase D5: Integration tests

**Depends on:** Phase D4 + working scatter runtime (Phases 4–10 of the main PLAN.md)
**Files:** `tests/decorators/`

See §6 (Test Plan) for all test cases.

**Exit criteria:** All decorator tests pass with `bun test`.

---

## 5. File Structure

### New files (decorator layer only)

```
scatter/
└── src/
    └── decorators/
        ├── index.ts              # Public exports + cleanupAllDecoratorPools
        ├── scaled.ts             # @Scaled() decorator implementation
        ├── worker-class.ts       # @WorkerClass() decorator implementation
        ├── serialize-state.ts    # serializeState() + isSerializable()
        └── build-worker-fn.ts   # normalizeMethodSource(), buildWorkerFnSource(),
                                  #   buildOneshotWorkerFn(), buildPoolWorkerFn(),
                                  #   buildClassDispatcherSource(),
                                  #   WorkerPayload, ClassDispatchPayload interfaces

tests/
└── decorators/
    ├── serialize-state.test.ts
    ├── build-worker-fn.test.ts
    ├── scaled.test.ts
    └── worker-class.test.ts
```

### Modified files

| File | Change |
|------|--------|
| `package.json` | Add `./decorators` entry to `exports` map |

### Untouched files (all existing scatter internals)

All files in `src/runtime/`, `src/memory/`, `src/scaffold.ts`, `src/virtual-worker.ts`,
`src/error.ts`, `src/protocol.ts`, `src/context.ts`, `src/scatter.ts`, `src/index.ts`.

---

## 6. Test Plan

Tests are designed around **behaviors**, not individual assertions. Each test verifies
what SHOULD happen and asserts that common failure modes DON'T happen within the same case.

### Unit tests: `serialize-state.test.ts`

| Test | What it covers |
|------|----------------|
| SS.1 | **Mixed-field class instance** — Create an object with: `string`, `number`, `Date`, `Uint8Array`, `Map`, `Set`, `RegExp` (all serializable), plus `function`, `symbol`, `undefined`, `WeakMap`, `WeakRef`, circular ref (all non-serializable). Call `serializeState()` once. Assert all 7 serializable fields are present and correct. Assert all 6 non-serializable fields are absent. Assert no error thrown. |
| SS.2 | **Empty and trivial inputs** — Empty object `{}` returns `{}`. Object with only non-serializable fields returns `{}`. Object with a single primitive field returns that field. |

### Unit tests: `build-worker-fn.test.ts`

| Test | What it covers |
|------|----------------|
| BW.1 | **`normalizeMethodSource` handles all method kinds** — Feed: regular shorthand `foo(x) { ... }`, async `async foo(x) { ... }`, generator `*foo(x) { ... }`, async generator `async *foo(x) { ... }`, arrow `(x) => x`, and `function foo(x) { ... }`. Assert each produces a valid function declaration (starts with `function`/`async function`). Assert arrows and `function`-prefixed inputs pass through unchanged. If Bun returns TS source from `fn.toString()`, assert transpilation strips types. |
| BW.2 | **`buildOneshotWorkerFn` produces a working function** — Build from a normalized `function add(a, b) { return a + b }`. Call the result with a mock `ctx = { data: { __state: { x: 1 }, __args: [2, 3] } }`. Assert return value is `5`. Assert the result is `typeof 'function'` (not a string). Assert the source (`.toString()`) contains `ctx.data.__state` and `__originalFn.apply`. |
| BW.3 | **`buildPoolWorkerFn` produces a working function** — Build from the same source. Call with mock `(ctx, { __state: { x: 1 }, __args: [2, 3] })`. Assert return value is `5`. Assert source contains `input.__state` (not `ctx.data`). |
| BW.4 | **`buildClassDispatcherSource` dispatches and guards correctly** — Build a dispatcher from a class with methods `compute(n)` and `helper()`. Assert dispatching `{ __method: 'compute', __args: [7], __state: {} }` returns the right value. Assert `{ __method: 'unknown', ... }` throws with a descriptive error. Assert a state field named `compute` (collides with method) is dropped — method still callable via `this.compute()`. |

### Integration tests: `scaled.test.ts`

| Test | What it covers |
|------|----------------|
| SC.1 | **Oneshot basic + state + errors** — Decorate a method with `@Scaled()` that reads `this.multiplier`. Call it: assert correct result, assert `this.multiplier` was accessible in the worker. Call a throwing method: assert rejects with `ThreadExecutionError`. Assert non-serializable fields on the instance don't cause errors (silently dropped). |
| SC.2 | **Oneshot async + timeout + static** — Decorate an async method with `@Scaled()`: assert it awaits correctly. Decorate a static method: assert it works and doesn't attempt state serialization. Use `@Scaled({ timeout: 50 })` on a slow method: assert rejects with `ThreadTimeoutError`. |
| SC.3 | **Pool mode lifecycle** — Decorate with `@Scaled({ pool: 4 })`. Fire 20 concurrent calls: assert all return correct results. Create two instances of the same class: assert they share the same pool (lazy-init on first call). Decorate a second method on the same class: assert it gets a separate pool. Call `cleanupAllDecoratorPools()`: assert all pools shut down. |
| SC.4 | **Validation rejects bad options** — Assert `@Scaled({ pool: 0 })`, `@Scaled({ pool: 1.5 })`, and `@Scaled({ pool: 4, concurrency: 0 })` all throw `TypeError`. Assert `@Scaled({ pool: 4, timeout: 1000 })` emits a `console.warn` at decoration time (timeout ignored in pool mode). |

### Integration tests: `worker-class.test.ts`

| Test | What it covers |
|------|----------------|
| WC.1 | **Proxy identity + method dispatch** — `new MyClass()` returns a value where `instanceof OriginalClass` is `true`. All public methods return `Promise`. Args and instance state are passed correctly to the worker. A throwing method rejects with `ThreadExecutionError`. Non-method fields (numbers, strings) return raw values (not proxied). `_prefixed` methods and symbol-keyed methods are NOT proxied. |
| WC.2 | **Pool sharing + internal calls + concurrency** — Two instances share the same pool (pool created on first `new`, not first method call). Fire 50 concurrent calls: all resolve correctly. A method calling `this.otherMethod()` inside the worker runs inline (no re-dispatch). State field colliding with a method name is dropped — method still works. |
| WC.3 | **Disposal + cleanup** — `MyClass.disposeWorkers()` shuts down the pool; subsequent calls fail. `cleanupAllDecoratorPools()` cleans up across multiple decorated classes. Multiple `@WorkerClass` classes coexist with separate pools. |
| WC.4 | **Validation rejects bad options** — Assert `@WorkerClass({ pool: 0 })`, `@WorkerClass({ pool: false as any })`, and `@WorkerClass({ concurrency: -1 })` all throw `TypeError`. |

---

## 7. Edge Cases & Constraints

### 7.1 Self-recursion

**Problem:** `fibonacci(n - 1)` inside a `@Scaled` method calls `this.fibonacci`. Inside the
worker, `this` is a plain object reconstructed from state — it does NOT have `fibonacci` as a
method. The call will throw `TypeError: this.fibonacci is not a function`.

**Solution:** Document clearly. Provide the canonical pattern:

```ts
// DON'T: self-recursive @Scaled method
class Bad {
  @Scaled({ pool: 4 })
  fib(n: number): number {
    if (n <= 1) return n;
    return this.fib(n - 1) + this.fib(n - 2); // BROKEN — this.fib is undefined in worker
  }
}

// DO: extract the recursive logic as a plain function
function fibInner(n: number): number {
  if (n <= 1) return n;
  return fibInner(n - 1) + fibInner(n - 2); // calls local function, not this.method
}

class Good {
  @Scaled({ pool: 4 })
  fib(n: number): number {
    return fibInner(n); // worker executes fibInner without needing this
  }
}
```

This is a **documented limitation** in the README and JSDoc, not a bug to fix.

---

### 7.2 `@WorkerClass` method-to-method calls

**Problem:** `methodA` calls `this.methodB()` inside the worker. Does this re-dispatch to the
pool (double-dispatch) or run inline?

**Solution:** In the `@WorkerClass` dispatcher (§4 Phase D3), we construct:
```js
const __safeState = {};  // state fields with method-name collisions removed (§7.18)
for (const __key of Object.keys(__state)) {
  if (!(__key in __methods)) __safeState[__key] = __state[__key];
}
const __self = Object.assign(Object.create(__methods), __safeState);
```

`__methods` is an object with all the original (unproxied) method functions, placed on the
prototype via `Object.create(__methods)`. State fields are assigned as own properties, but
only if they don't collide with method names (see §7.18). So `this.methodB()` inside the
worker calls `__methods.methodB` directly — it does NOT go through the proxy, does NOT
dispatch to the pool. This is the correct behavior for performance and simplicity.

---

### 7.3 Getters and setters

**Problem:** Classes may have `get foo()` / `set foo(v)` on the prototype. The `Object.getOwnPropertyNames(prototype)` scan will include them. They are NOT methods.

**Mitigation:** Before adding a name to `methodNames`, check:
```ts
const descriptor = Object.getOwnPropertyDescriptor(OriginalClass.prototype, name);
if (!descriptor || typeof descriptor.value !== 'function') continue;
```

Getters/setters have `descriptor.get`/`descriptor.set` but not `descriptor.value`. This
correctly excludes them from the proxied method set.

---

### 7.4 Inherited methods

**Problem:** `Object.getOwnPropertyNames(prototype)` only returns own properties. Methods
inherited from base classes are not included. If a subclass is decorated with `@WorkerClass`,
its base class methods won't be proxied.

**Decision:** Only own prototype methods are proxied. Inherited methods are NOT proxied —
they call through to the real instance method on the main thread. This is a documented
limitation. A future enhancement could walk the prototype chain.

---

### 7.5 `toString()` and TypeScript source — BLOCKING PREREQUISITE

> **BLOCKING:** This issue MUST be resolved in Phase D1.4 before ANY Phase D2/D3 work begins.
> The entire decorator architecture depends on `fn.toString()` producing valid JavaScript.

**Problem:** In strict mode, `function.toString()` returns the exact source text. For
TypeScript-compiled code (Bun runs TypeScript directly), the source reflects the original TS
source including types.

**Constraint:** The generated worker function source must be valid JavaScript, not TypeScript.
Since scatter workers run as JavaScript (Blob URL), type annotations in method bodies would
cause syntax errors.

**Mitigation:** Bun strips TypeScript types during its JIT compilation. When `method.toString()`
is called on a Bun-compiled method, the returned string may still contain TypeScript syntax
(including parameter type annotations) depending on Bun's implementation.

**Required investigation (Phase D1.4):**
1. Write a test class with typed methods in TypeScript
2. Call `method.toString()` on each method at runtime in Bun
3. Verify whether the output contains TypeScript syntax or plain JavaScript
4. Document the result as a known fact for the decorator implementation

**If toString() returns TypeScript source:** Implement a mandatory transpilation step in
`normalizeMethodSource()`:
```ts
function normalizeMethodSource(fnSource: string): string {
  // Step 1: Strip TypeScript syntax using Bun's in-process transpiler.
  // This is O(source-length) but runs only once per decorated method (at decoration time).
  const jsSource = Bun.transpileSync(
    `const __fn = ${fnSource}`,
    { loader: 'ts', target: 'browser' },
  );
  // Extract the function source from the transpiled output
  const normalized = jsSource.replace(/^const __fn = /, '').replace(/;\s*$/, '');

  // Step 2: Apply method-shorthand normalization (existing logic)
  return normalizeMethodShorthand(normalized);
}
```

**If toString() returns JavaScript source:** No transpilation needed — proceed with the
existing `normalizeMethodSource` logic. Document the finding for future reference.

**Exit criteria for D1.4:** A passing test that proves which behavior Bun exhibits, and
`normalizeMethodSource` handles it correctly in both cases.

---

### 7.6 Non-serializable `this`

**Problem:** Class instances may contain non-serializable fields. Silently dropping them
(Decision 8) means the worker doesn't have the full object state. The method may produce
incorrect results without any warning.

**Mitigation:**
1. In development mode (`NODE_ENV !== 'production'` or `Bun.env.SCATTER_DEBUG`), log a warning
   when fields are dropped: `console.warn('[scatter] Non-serializable field dropped: fieldName')`.
2. Document the constraint clearly.
3. Provide guidance: use serializable primitive fields for state that methods depend on;
   keep non-serializable objects (file handles, sockets) only on the main thread.

---

### 7.7 `@Scaled` on static methods

**Problem:** Decorating a static method with `@Scaled` should work — `this` in a static
method is the class constructor, not an instance. `serializeState(this)` on a constructor
would serialize the constructor's own enumerable properties (typically none).

**Decision:** `@Scaled` works on static methods. The replacement function uses
`context.static` (a boolean on Stage 3 `ClassMethodDecoratorContext`) to determine behavior:

```ts
// Inside the replacement method:
return async function (this: This, ...args: Args): Promise<Awaited<Return>> {
  // For static methods, skip state serialization entirely —
  // 'this' is the class constructor, not a useful state object
  const state = context.static ? {} : serializeState(this as object);
  // ... rest of dispatch logic
};
```

**Disposal for static @Scaled methods:** Since `addInitializer` for a static method decorator
runs with `this` bound to the class constructor, we do NOT use it for disposal registration.
All `@Scaled` pools (instance and static) are cleaned up via `cleanupAllDecoratorPools()`.
The `addInitializer` callback is NOT used for pool creation or disposal — pools are created
lazily on first call (see `getOrCreatePool`), and the `addInitializer` callback in the Phase D2
sketch is a no-op placeholder that can be removed.

---

### 7.8 `@WorkerClass` with abstract methods

**Problem:** If the decorated class has abstract methods (TypeScript feature), they won't
have implementations on the prototype. The dispatcher scanner will skip them (since
`typeof descriptor.value !== 'function'`).

**Decision:** Abstract methods are silently skipped. Subclasses that implement them are not
decorated (the decorator is on the abstract class, not the subclass). This is a known
limitation — `@WorkerClass` is designed for concrete classes.

---

### 7.9 `_private` method interaction with proxy dispatch

**Problem:** Methods prefixed with `_` are NOT proxied — the proxy handler passes them
through via `Reflect.get(target, prop, receiver)`. This means `_privateMethod()` executes
synchronously on the main thread. However, `receiver` is the Proxy itself, so inside
`_privateMethod`, `this` refers to the Proxy. If `_privateMethod` calls `this.publicMethod()`,
that call IS intercepted by the Proxy and dispatched to the worker pool.

**Example of the interaction:**

```ts
@WorkerClass({ pool: 2 })
class MyService {
  _helper(): number { return this.compute(42); } // this.compute → PROXIED → worker
  compute(n: number): number { return n * 2; }   // proxied method
}

const svc = new MyService();
// svc._helper() runs on main thread, but internally calls this.compute(42)
// which goes through the proxy → dispatched to worker pool → returns Promise<84>
// BUT: _helper() is synchronous, so it returns the Promise object, not 84
```

**Decision:** This is **documented behavior**, not a bug. The rule is:
- `_prefixed` methods run on the main thread synchronously
- If a `_prefixed` method calls `this.publicMethod()`, that call IS proxied (returns a Promise)
- Users must be aware that mixing sync `_private` calls with proxied public methods
  requires proper `await` handling

This is documented in the JSDoc for `@WorkerClass` and in the README.

---

### 7.10 Proxy transparency

**Problem:** Some code checks `typeof instance` (returns `'object'` through Proxy — OK),
`instance.constructor` (returns the replacement class — OK), `instance instanceof OriginalClass`
(returns `true` — OK since replacement class extends original). JSON.stringify, spread, etc.
all work through Proxy.

**Issue:** `Object.getOwnPropertyNames(instance)` returns own properties of the proxy
TARGET (the real instance), not the proxy handler's intercepted properties. This is correct
behavior but worth documenting.

---

### 7.11 Pool exhaustion and backpressure

**Problem:** If 100 concurrent `await instance.method()` calls are made and the pool has
`size: 2, maxQueue: undefined`, all 100 calls queue and dispatch. This may consume significant
memory for buffered arguments.

**Decision:** Both `ScaledOptions` and `WorkerClassOptions` now expose a `maxQueue` option
(see §2.1 and §2.2) that forwards to the underlying `scatter.pool()` call. The default
remains unbounded (`Infinity`), matching the runtime's behavior. Users who need backpressure
can set `@Scaled({ pool: 4, maxQueue: 100 })` or `@WorkerClass({ pool: 2, maxQueue: 50 })`.

---

### 7.12 Pool disposal and test isolation

**Problem:** In test suites with multiple `describe` blocks, pools created by `@Scaled` and
`@WorkerClass` persist across tests if not explicitly cleaned up. This causes test pollution
and resource leak warnings.

**Recommendation:** Add `afterAll(() => cleanupAllDecoratorPools())` in test files that use
decorated classes. Document this pattern in the README.

---

### 7.13 TypeScript `experimentalDecorators` conflict

**Problem:** If a user's `tsconfig.json` has `"experimentalDecorators": true`, TypeScript uses
the legacy decorator spec, which has a different function signature. Our Stage 3 decorator
implementation would not type-check correctly.

**Mitigation:** Add a runtime check at the top of `scaled.ts` / `worker-class.ts` that throws
a clear error if the legacy decorator API is being used:

```ts
// The context.kind check differentiates Stage 3 from legacy decorators
// Legacy decorators do not receive a 'context' parameter at all
```

Actually, this is a TypeScript/compile-time issue, not a runtime issue. Add a clear note in
the README: "requires TypeScript 5.0+ with no `experimentalDecorators` flag." If a user has
the flag set, TypeScript will report type errors on the decorator implementations.

---

### 7.14 Runtime `PoolOptions.data` not forwarded through decorators

**Problem:** The scatter runtime's `PoolOptions` supports a `data` property for static
per-pool data accessible in workers via `ctx.data`. The decorator API does NOT use `ctx.data`
for per-task transport — pool mode uses the `input` parameter (second argument to the worker
function), not `ctx.data`. However, `ctx.data` is still set at pool init time by the runtime
with `{ __workerIndex: i }`. The decorator's worker functions ignore `ctx.data` entirely in
pool mode — they read from `input.__state`, `input.__args`, and `input.__method`.

For oneshot `@Scaled()` mode, `ctx.data` IS the transport — `scatter()` passes
`options.data` through to the worker as `ctx.data`, so `ctx.data.__state` and
`ctx.data.__args` are correct.

**Decision:** `PoolOptions.data` is intentionally NOT exposed through the decorator API.
The pool-mode worker functions read exclusively from the `input` parameter (set per-task via
`pool.exec(input)`), while `ctx.data` contains runtime-managed metadata (`__workerIndex`).
Users who need static per-worker data should use the `scatter.pool()` API directly.
This is a documented limitation in the JSDoc for both `ScaledOptions` and `WorkerClassOptions`.

---

### 7.15 `#pool` private static prevents subclass pool access

**Problem:** In Phase D3, the `@WorkerClass` replacement class stores the pool as
`static #pool` (true private via JS `#`-prefix). This means subclasses cannot access or
override the pool.

**Decision:** This is **intentional**. Each `@WorkerClass`-decorated class owns exactly one
pool. Subclassing a `@WorkerClass` class is not a supported pattern — if a subclass also
needs worker dispatch, it should be independently decorated with `@WorkerClass`. The private
`#pool` prevents accidental mutation from subclasses and keeps the lifecycle clean.

---

### 7.16 Worker context properties (`ctx.threadId`, `ctx.workerIndex`)

**Problem:** The scatter runtime provides `ctx.threadId` (on all workers) and
`ctx.workerIndex` (on pool workers) inside the worker function. These are available in the
generated dispatcher functions but are NOT exposed to the user's method body.

**Decision:** In the generated worker scaffold, `ctx` is consumed by the decorator wrapper
and not passed through to the original method. The user's method receives `this` (reconstructed
state) and `args` only. If a user needs `ctx.threadId` or `ctx.workerIndex`, they should use
the `scatter.pool()` API directly. This is documented as a known limitation.

**Future enhancement:** A `@Scaled({ exposeContext: true })` option could pass `ctx` as an
extra parameter, but this is out of scope for v1.

---

### 7.17 AbortSignal support

> **IMPORTANT LIMITATION:** The decorator API does NOT support per-call cancellation.
> If your use case requires cancelling individual worker tasks, use the `scatter()` /
> `scatter.pool()` runtime API directly instead of decorators.

**Problem:** The scatter runtime supports `pool.exec(input, { signal })` for per-task
cancellation, and `scatter(fn, { signal })` for oneshot cancellation. Neither `ScaledOptions`
nor `WorkerClassOptions` exposes a `signal` property for per-call cancellation from the
decorator API.

**Decision:** Per-call `AbortSignal` is NOT supported in v1 of the decorator API. The reason:
the decorator replaces the method signature, and adding an optional `signal` parameter changes
the method's arity in a way that doesn't compose well with existing code. Users who need
per-call cancellation should use `scatter()` / `scatter.pool()` directly.

**Workaround (result abandonment only — does NOT cancel the worker):**

Users can abandon the result at the Promise level, but the worker task continues running
and consuming resources until it completes:

```ts
const result = await Promise.race([
  svc.heavyCompute(n),
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
]);
// WARNING: If the signal aborts, the worker task continues running in the background.
// The result is discarded, but the worker thread is NOT terminated.
// For true cancellation, use scatter.pool().exec(input, { signal }) directly.
```

**Why this matters:** Abandoned-but-still-running workers consume CPU, memory, and pool
capacity. In pool mode, an abandoned task still occupies a worker slot until it completes,
reducing effective throughput for other calls. This is a fundamental limitation of the
decorator API's fire-and-forget dispatch model.

---

### 7.18 State field / method name collision in `@WorkerClass`

**Problem:** If an instance has a state field with the same name as a prototype method
(e.g., `this.compute = 42` and a method `compute(n: number): number`), the state field
would shadow the method in the reconstructed object inside the worker. Then
`this.compute(...)` called from another method would throw
`TypeError: this.compute is not a function`.

**Solution:** The class dispatcher (§4 Phase D3, `buildClassDispatcherSource`) filters out
state fields that collide with method names before assigning them to the reconstructed object:

```ts
// Inside the generated dispatcher source:
const __safeState = {};
for (const __key of Object.keys(__state)) {
  if (!(__key in __methods)) __safeState[__key] = __state[__key];
}
const __self = Object.assign(Object.create(__methods), __safeState);
```

**Trade-off:** The colliding state field is silently dropped inside the worker. If the
method body reads `this.compute` expecting the numeric value (not the method), it gets the
method function instead. This is an inherent conflict — a property cannot be both a value
and a function. The method wins because method dispatch is the primary purpose of the
decorator.

**Recommendation:** Document this behavior. Users should avoid naming instance fields with
the same names as prototype methods.

---

### 7.19 `@Scaled` timeout ignored in pool mode

**Problem:** If a user writes `@Scaled({ pool: 4, timeout: 5000 })`, the `timeout` option
is silently ignored because pool mode does not support per-task timeouts through the
decorator API.

**Solution:** A `console.warn` is emitted **at decoration time** (once per decorated method,
not per call) when `timeout` and `pool` are both specified:

```ts
if (usePool && options?.timeout !== undefined) {
  console.warn(
    `[scatter] @Scaled on '${String(context.name)}': timeout option is ignored in pool mode. ` +
    `Use scatter.pool() directly for per-task timeouts.`,
  );
}
```

This ensures the user sees the warning during development without per-call noise.

---

## Dependency Graph

```
                         PLAN.md phases required:
                         ─────────────────────────
                         Phase 4  (Channel factory) ──┐
                         Phase 5  (scatter oneshot)    │
                         Phase 7  (scatter.pool)  ─────┤
                         Phase 10 (wiring)             │
                         (All must be ✅)              │
                                                       │
                                                       ▼
D1: serialize-state + build-worker-fn                  │
  (no scatter dependencies — can start now)            │
         │                                             │
         ▼                                             │
D2: @Scaled decorator ─────────────────────────────────┤
D3: @WorkerClass decorator ────────────────────────────┤
         │                                             │
         ▼                                             │
D4: Index + entry wiring ──────────────────────────────┘
         │
         ▼
D5: Integration tests
```

**Parallelizable work:**
- D1 (utilities) can start IMMEDIATELY — no scatter runtime needed
- **GATE:** D1.4 (TypeScript toString() investigation) is a BLOCKING prerequisite for D2 and D3.
  If Bun returns TypeScript source, the transpilation fallback must be implemented in D1 first.
- D2 and D3 are independent of each other; start both when D1 (including D1.4) and scatter runtime are done
- D4 is trivial, takes < 30 min after D2 and D3

---

## Estimated Complexity

| Phase | Complexity | Key risk |
|-------|-----------|----------|
| D1: serialize-state + build-worker-fn | Medium | **BLOCKING:** TypeScript method source may include type annotations — D1.4 must verify `fn.toString()` output in Bun and implement transpilation fallback if needed. D2/D3 CANNOT start until this is resolved. |
| D2: @Scaled | Medium | Stage 3 decorator typing; pool lazy-init; validation must match scatter.pool() runtime |
| D3: @WorkerClass | High | Proxy construction; class method dispatcher generation; state/method collision guard; method-to-method call semantics |
| D4: Wiring | Low | Trivial |
| D5: Tests | Medium | Worker process coordination; pool lifecycle in test suite; validation edge cases |

---

## Unresolved Questions

| # | Question | Default | Status |
|---|----------|---------|--------|
| UQ.1 | Does `method.toString()` in Bun return TypeScript or JavaScript source? | Assume TypeScript (must transpile) | **BLOCKING — Phase D1.4 prerequisite. Must be resolved before D2/D3 begin.** |
| UQ.2 | Can `new Function('ctx', 'input', source)` be used in Bun Blob workers? (no eval restriction?) | Yes — Bun doesn't restrict eval by default | Phase D2 testing |
| ~~UQ.3~~ | ~~Should `@Scaled` pools have `maxQueue` exposed as an option?~~ | ~~No for v1~~ | **RESOLVED: Yes, added to both `ScaledOptions` and `WorkerClassOptions`** |
| UQ.4 | Should write-back of state from worker be supported in a future API? | No for v1 (snapshot semantics documented) | Post-v1 |
| UQ.5 | Should `@WorkerClass` walk the prototype chain for inherited methods? | No for v1 | Post-v1 |
| UQ.6 | Should there be a `@ScaledRecursive` variant that handles self-recursion? | Out of scope | Post-v1 if pattern is common |

---

## Summary

The decorator API is a thin ergonomic layer over the existing scatter runtime. No existing
code is modified. The two decorators (`@Scaled`, `@WorkerClass`) compile down to:

- `@Scaled()` → `scatter(oneshotWorkerFn, { data: { __state, __args } })` (oneshot, ctx.data transport)
- `@Scaled({ pool: N })` → `scatter.pool(poolWorkerFn, { size: N }).exec({ __state, __args })` (pool, input transport)
- `@WorkerClass({ pool: N })` → `scatter.pool(classDispatcherFn, { size: N })` + `Proxy` (pool, input transport with `__method`)

The key novel pieces are:
1. `serializeState()` — safe structured-clone filter for `this`
2. `normalizeMethodSource()` — handles regular, async, generator, and async generator method shorthands; includes TypeScript transpilation fallback if needed (see §7.5)
3. `buildOneshotWorkerFn()` / `buildPoolWorkerFn()` — source-level composition into scatter worker functions
4. The class dispatcher — a single pool worker function that handles all methods of a class, with state/method collision guard (see §7.18)
5. The Proxy handler — transparent interception of method calls with inline state serialization
6. `cleanupAllDecoratorPools()` — race-safe, graceful best-effort shutdown of all decorator-created pools
7. Validation layer — decorator-level TypeError for invalid pool size, concurrency, and pool: false (matches scatter.pool() runtime)

**Exported types:**
- `ScaledMethod<F>` — annotate correct post-decoration return type for `@Scaled` methods
- `WorkerProxied<T>` — map instance methods to async equivalents (NO `disposeWorkers` on instances)
- `WorkerClassStatic<T>` — static side of a `@WorkerClass` class (includes `disposeWorkers()`)

**Key limitations (documented):**
- No per-call `AbortSignal` support — use `scatter()` / `scatter.pool()` directly for cancellation (§7.17)
- No self-recursion in `@Scaled` methods — extract recursive logic to plain functions (§7.1)
- `timeout` option ignored in pool mode — console.warn emitted at decoration time (§7.19)
- State field / method name collisions in `@WorkerClass` — method wins, state field dropped (§7.18)
- `@WorkerClass` pool created on first instantiation, not first method call (Decision 10)
