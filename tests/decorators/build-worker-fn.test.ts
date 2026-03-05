import { describe, expect, test } from 'bun:test';
import {
  normalizeMethodSource,
  buildWorkerFnSource,
  buildOneshotWorkerFn,
  buildPoolWorkerFn,
} from '../../src/decorators/build-worker-fn.js';

describe('normalizeMethodSource', () => {
  test('BW.1: handles all method kinds', () => {
    // Regular method shorthand → function declaration
    const regular = normalizeMethodSource('foo(x) { return x + 1; }');
    expect(regular).toBe('function foo(x) { return x + 1; }');

    // Async method shorthand → async function declaration
    const async_ = normalizeMethodSource('async foo(x) { return x + 1; }');
    expect(async_).toBe('async function foo(x) { return x + 1; }');

    // Generator method shorthand → generator function declaration
    const gen = normalizeMethodSource('*foo(x) { yield x; }');
    expect(gen).toBe('function* foo(x) { yield x; }');

    // Async generator method shorthand → async generator function declaration
    const asyncGen = normalizeMethodSource('async *foo(x) { yield x; }');
    expect(asyncGen).toBe('async function* foo(x) { yield x; }');

    // Async generator with no space after async: "async* foo(x)"
    const asyncGenNoSpace = normalizeMethodSource('async* foo(x) { yield x; }');
    expect(asyncGenNoSpace).toBe('async function* foo(x) { yield x; }');

    // Arrow function passes through unchanged
    const arrow = '(x) => x * 2';
    expect(normalizeMethodSource(arrow)).toBe(arrow);

    // Methods containing inner arrows are still normalized as methods
    const methodWithInnerArrow = 'sum(values) { return values.reduce((a, b) => a + b, 0); }';
    expect(normalizeMethodSource(methodWithInnerArrow)).toBe(
      'function sum(values) { return values.reduce((a, b) => a + b, 0); }',
    );

    // Already a function expression passes through unchanged
    const funcExpr = 'function foo(x) { return x; }';
    expect(normalizeMethodSource(funcExpr)).toBe(funcExpr);

    // Already an async function passes through unchanged
    const asyncFunc = 'function async foo(x) { return x; }';
    // This starts with 'function' so passes through
    expect(normalizeMethodSource(asyncFunc)).toBe(asyncFunc);

    // Leading whitespace is handled
    const indented = '  foo(x) { return x; }';
    expect(normalizeMethodSource(indented)).toBe('function foo(x) { return x; }');
  });
});

describe('buildWorkerFnSource', () => {
  test('generates correct source with originalFn, state reconstruction, and apply call', () => {
    const source = buildWorkerFnSource('function add(a, b) { return a + b; }');

    expect(source).toContain('const __originalFn = function add(a, b) { return a + b; };');
    expect(source).toContain('const __self = Object.assign({}, __state);');
    expect(source).toContain('return __originalFn.apply(__self, __args);');
  });

  test('this is bound to __state via apply', () => {
    const fnSource = 'function getX() { return this.x; }';
    const source = buildWorkerFnSource(fnSource);

    // Execute the generated source with __state and __args in scope
    const executor = new Function('__state', '__args', source);
    const result = executor({ x: 42 }, []);
    expect(result).toBe(42);
  });
});

describe('buildOneshotWorkerFn', () => {
  test('BW.2: produces a working function', () => {
    const source = 'function add(a, b) { return a + b; }';
    const fn = buildOneshotWorkerFn(source);

    expect(typeof fn).toBe('function');

    // Call with mock ctx
    const result = fn({
      data: { __state: { x: 1 }, __args: [2, 3] },
    } as any);
    expect(result).toBe(5);

    // Source contains expected scaffolding
    const fnSource = fn.toString();
    expect(fnSource).toContain('ctx.data.__state');
    expect(fnSource).toContain('__originalFn.apply');
  });

  test('BW.2b: this is bound to state object', () => {
    const source = 'function getX() { return this.x; }';
    const fn = buildOneshotWorkerFn(source);

    const result = fn({
      data: { __state: { x: 99 }, __args: [] },
    } as any);
    expect(result).toBe(99);
  });

  test('BW.2c: defaults to empty state and args when missing', () => {
    const source = 'function noop() { return 42; }';
    const fn = buildOneshotWorkerFn(source);

    const result = fn({ data: {} } as any);
    expect(result).toBe(42);
  });
});

describe('buildPoolWorkerFn', () => {
  test('BW.3: produces a working function', () => {
    const source = 'function add(a, b) { return a + b; }';
    const fn = buildPoolWorkerFn(source);

    expect(typeof fn).toBe('function');

    // Call with mock ctx and input
    const result = fn({} as any, { __state: { x: 1 }, __args: [2, 3] });
    expect(result).toBe(5);

    // Source contains input.__state (not ctx.data)
    const fnSource = fn.toString();
    expect(fnSource).toContain('input.__state');
    expect(fnSource).not.toContain('ctx.data.__state');
  });

  test('BW.3b: this is bound to state object', () => {
    const source = 'function getY() { return this.y; }';
    const fn = buildPoolWorkerFn(source);

    const result = fn({} as any, { __state: { y: 77 }, __args: [] });
    expect(result).toBe(77);
  });

  test('BW.3c: defaults to empty state and args when missing', () => {
    const source = 'function noop() { return "ok"; }';
    const fn = buildPoolWorkerFn(source);

    const result = fn({} as any, { __state: {}, __args: [] });
    expect(result).toBe('ok');
  });
});
