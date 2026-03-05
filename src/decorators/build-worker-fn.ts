/**
 * Utilities for building worker function sources from decorated method sources.
 *
 * Bun's fn.toString() returns JavaScript (type annotations stripped),
 * so no TypeScript transpilation is needed.
 */

import type { PoolWorkerContext, ThreadContext } from '../context.js';

/**
 * State + args payload for @Scaled oneshot and pool mode.
 * Used by buildOneshotWorkerFn and buildPoolWorkerFn.
 */
export interface WorkerPayload {
  readonly __state: Record<string, unknown>;
  readonly __args: unknown[];
}

/**
 * Converts method shorthand source from fn.toString() into a valid
 * function declaration/expression.
 *
 * Handles: regular, async, generator, and async generator methods.
 * Already-valid function expressions/declarations and arrows pass through unchanged.
 */
export function normalizeMethodSource(fnSource: string): string {
  const trimmed = fnSource.trimStart();
  const firstBraceIndex = trimmed.indexOf('{');
  const signature = firstBraceIndex === -1 ? trimmed : trimmed.slice(0, firstBraceIndex);

  // Already a function expression/declaration or arrow: pass through
  if (trimmed.startsWith('function') || signature.includes('=>')) return fnSource;

  // Async generator method: "async* name(...) { ... }" or "async *name(...) { ... }"
  if (trimmed.startsWith('async') && trimmed.slice(5).trimStart().startsWith('*')) {
    const afterAsync = trimmed.slice(5).trimStart(); // "*name(...) { ... }"
    const afterStar = afterAsync.slice(1).trimStart(); // "name(...) { ... }"
    return `async function* ${afterStar}`;
  }

  // Async method: "async name(...) { ... }"
  if (trimmed.startsWith('async')) {
    const afterAsync = trimmed.slice(5).trimStart(); // "name(...) { ... }"
    return `async function ${afterAsync}`;
  }

  // Generator method: "*name(...) { ... }"
  if (trimmed.startsWith('*')) {
    const afterStar = trimmed.slice(1).trimStart(); // "name(...) { ... }"
    return `function* ${afterStar}`;
  }

  // Regular method shorthand: "name(...args) { body }"
  return `function ${trimmed}`;
}

/**
 * Generates the worker function source string that embeds the original function
 * and calls it with reconstructed `this` from `__state` and deserialized `__args`.
 *
 * The generated source expects two variables in scope:
 * - `__state`: Record<string, unknown> — serialized instance state
 * - `__args`: unknown[] — method arguments
 *
 * The caller (buildOneshotWorkerFn / buildPoolWorkerFn) is responsible for
 * extracting these from the appropriate source (ctx.data vs input).
 *
 * @param normalizedFnSource - Output of normalizeMethodSource(originalFn.toString())
 * @returns Source code string that declares the original function, reconstructs
 *          `this`, and calls the function via `.apply()`
 */
export function buildWorkerFnSource(normalizedFnSource: string): string {
  return [
    `const __originalFn = ${normalizedFnSource};`,
    `const __self = Object.assign({}, __state);`,
    `return __originalFn.apply(__self, __args);`,
  ].join('\n');
}

/**
 * Build a oneshot worker function for scatter().
 *
 * Returns a real Function whose .toString() embeds the original method source.
 * scatter() calls fn.toString() internally — the generated source includes the
 * state reconstruction and method invocation scaffold.
 *
 * The generated wrapper is intentionally NOT async. If the original method
 * is async, `__originalFn.apply(...)` returns a Promise, and the wrapper returns
 * that Promise directly. The scatter scaffold does `await __fn(ctx)`, which
 * correctly awaits the returned Promise. Making the wrapper async would add an
 * unnecessary extra microtask tick.
 *
 * @param normalizedFnSource - Output of normalizeMethodSource(originalFn.toString())
 */
export function buildOneshotWorkerFn(
  normalizedFnSource: string,
): (ctx: ThreadContext) => unknown {
  return new Function(
    'ctx',
    [
      `const __state = ctx.data.__state ?? {};`,
      `const __args = ctx.data.__args ?? [];`,
      buildWorkerFnSource(normalizedFnSource),
    ].join('\n'),
  ) as (ctx: ThreadContext) => unknown;
}

/**
 * Build a pool worker function for scatter.pool().
 *
 * Pool workers receive (ctx, input) where input is the WorkerPayload
 * passed via pool.exec(). The generated function reconstructs `this` from
 * input.__state and calls the original method with input.__args.
 *
 * The generated wrapper is intentionally NOT async — if the original method
 * is async, the returned Promise propagates naturally through the pool runtime.
 *
 * @param normalizedFnSource - Output of normalizeMethodSource(originalFn.toString())
 */
export function buildPoolWorkerFn(
  normalizedFnSource: string,
): (ctx: PoolWorkerContext, input: WorkerPayload) => unknown {
  return new Function(
    'ctx',
    'input',
    [
      `const __state = input.__state ?? {};`,
      `const __args = input.__args ?? [];`,
      buildWorkerFnSource(normalizedFnSource),
    ].join('\n'),
  ) as (ctx: PoolWorkerContext, input: WorkerPayload) => unknown;
}
