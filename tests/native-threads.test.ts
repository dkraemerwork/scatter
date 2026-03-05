import { describe, test, expect, beforeAll } from 'bun:test';
import { NativeThreads, NativeThreadError } from '../src/native/index.js';

/**
 * Native threads test suite.
 *
 * These tests compile burn.c at runtime via Bun's built-in TCC compiler
 * and exercise the native pthread burn API.
 */

let native: NativeThreads;

beforeAll(async () => {
  native = await NativeThreads.create();
});

describe('NativeThreads.create()', () => {
  test('creates an instance with hwThreads > 0', () => {
    expect(native).toBeInstanceOf(NativeThreads);
    expect(native.hwThreads).toBeGreaterThan(0);
  });

  test('hwThreads matches navigator.hardwareConcurrency', () => {
    expect(native.hwThreads).toBe(navigator.hardwareConcurrency);
  });

  test('pre-compiled library loading throws on bad path', () => {
    expect(
      NativeThreads.create({ libraryPath: '/nonexistent/libfoo.dylib' }),
    ).rejects.toThrow(NativeThreadError);
  });
});

describe('NativeThreads.burn()', () => {
  test('single thread, short burn returns valid result', () => {
    const results = native.burn({ threads: 1, durationMs: 100 });

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.threadId).toBe(0);
    expect(r.pi).toBeCloseTo(Math.PI, 1); // at least 1 decimal place in 100ms
    expect(r.iterations).toBeGreaterThan(0);
    expect(r.allocatedMB).toBe(0);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(90); // ~100ms with tolerance
    expect(r.elapsedMs).toBeLessThan(500);
  });

  test('multiple threads return one result per thread', () => {
    const threadCount = Math.min(native.hwThreads, 4);
    const results = native.burn({ threads: threadCount, durationMs: 100 });

    expect(results).toHaveLength(threadCount);

    // Every thread ID should be unique and in [0, threadCount)
    const ids = results.map((r) => r.threadId).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: threadCount }, (_, i) => i));

    // Every thread computed something
    for (const r of results) {
      expect(r.pi).toBeCloseTo(Math.PI, 0);
      expect(r.iterations).toBeGreaterThan(0);
    }
  });

  test('defaults to all hardware threads', () => {
    const results = native.burn({ durationMs: 50 });
    expect(results).toHaveLength(native.hwThreads);
  });

  test('memory allocation is reported correctly', () => {
    const results = native.burn({ threads: 1, durationMs: 50, memoryMB: 2 });

    expect(results).toHaveLength(1);
    expect(results[0].allocatedMB).toBe(2);
  });

  test('zero duration still produces results', () => {
    const results = native.burn({ threads: 1, durationMs: 0 });

    expect(results).toHaveLength(1);
    // Even with 0ms, the inner loop runs at least one batch (500K iterations)
    expect(results[0].iterations).toBeGreaterThanOrEqual(500_000);
  });

  test('results are independent across threads', () => {
    const results = native.burn({ threads: 2, durationMs: 200 });

    expect(results).toHaveLength(2);
    // Both should converge on π but may have different iteration counts
    for (const r of results) {
      expect(Math.abs(r.pi - Math.PI)).toBeLessThan(0.01);
    }
  });
});

describe('NativeThreads.burn() validation', () => {
  test('throws on threads <= 0', () => {
    expect(() => native.burn({ threads: 0 })).toThrow(NativeThreadError);
    expect(() => native.burn({ threads: -1 })).toThrow(NativeThreadError);
  });

  test('throws on negative durationMs', () => {
    expect(() => native.burn({ threads: 1, durationMs: -1 })).toThrow(NativeThreadError);
  });

  test('throws on negative memoryMB', () => {
    expect(() => native.burn({ threads: 1, memoryMB: -1 })).toThrow(NativeThreadError);
  });
});

describe('NativeThreads.burnAsync()', () => {
  test('returns same results as sync burn', async () => {
    const results = await native.burnAsync({ threads: 1, durationMs: 50 });

    expect(results).toHaveLength(1);
    expect(results[0].pi).toBeCloseTo(Math.PI, 0);
    expect(results[0].iterations).toBeGreaterThan(0);
  });

  test('multiple threads async', async () => {
    const results = await native.burnAsync({ threads: 2, durationMs: 100 });

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.threadId).sort((a, b) => a - b);
    expect(ids).toEqual([0, 1]);
  });
});

describe('NativeThreads vs Bun Workers comparison', () => {
  test('native threads compute π within tolerance', () => {
    const results = native.burn({ threads: 1, durationMs: 500 });
    const nativePi = results[0].pi;

    // With 500ms of burn, π should be accurate to at least 5 decimal places
    expect(Math.abs(nativePi - Math.PI)).toBeLessThan(0.00001);
  });

  test('all threads produce valid π approximations', () => {
    const threadCount = Math.min(native.hwThreads, 4);
    const results = native.burn({ threads: threadCount, durationMs: 200 });

    for (const r of results) {
      // Each thread independently computes π
      expect(Math.abs(r.pi - Math.PI)).toBeLessThan(0.001);
    }
  });

  test('iteration throughput is measurable', () => {
    const results = native.burn({ threads: 1, durationMs: 200 });
    const r = results[0];

    const itersPerSec = r.iterations / (r.elapsedMs / 1000);
    // Native C should do at least 100M iterations/sec on any modern CPU
    expect(itersPerSec).toBeGreaterThan(50_000_000);
  });
});

describe('NativeThreadError', () => {
  test('is instanceof ScatterError', async () => {
    const { ScatterError } = await import('../src/error.js');
    const err = new NativeThreadError('test');
    expect(err).toBeInstanceOf(ScatterError);
    expect(err).toBeInstanceOf(NativeThreadError);
    expect(err.name).toBe('NativeThreadError');
  });

  test('has _tag discriminant', () => {
    const err = new NativeThreadError('test');
    expect(err._tag).toBe('NativeThreadError');
  });
});
