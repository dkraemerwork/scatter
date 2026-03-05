import { describe, test, expect } from 'bun:test';
import { createAtomicSignal, atomicSignalFromBuffer } from '../../src/memory/atomic-signal.js';

describe('AtomicSignal', () => {
  test('notify then wait returns ok', () => {
    const signal = createAtomicSignal();
    signal.notify();
    expect(signal.wait(100)).toBe('ok');
  });

  test('wait without notify times out', () => {
    const signal = createAtomicSignal();
    expect(signal.wait(10)).toBe('timed-out');
  });

  test('peek reflects signaled state', () => {
    const signal = createAtomicSignal();
    expect(signal.peek()).toBe(false);
    signal.notify();
    expect(signal.peek()).toBe(true);
  });

  test('reset clears signaled state', () => {
    const signal = createAtomicSignal();
    signal.notify();
    expect(signal.peek()).toBe(true);
    signal.reset();
    expect(signal.peek()).toBe(false);
  });

  test('wait auto-resets after consuming', () => {
    const signal = createAtomicSignal();
    signal.notify();
    signal.wait(100);
    expect(signal.peek()).toBe(false);
  });

  test('waitAsync resolves on notify', async () => {
    const signal = createAtomicSignal();
    setTimeout(() => signal.notify(), 10);
    const result = await signal.waitAsync(1000);
    expect(result).toBe('ok');
  });

  test('waitAsync times out', async () => {
    const signal = createAtomicSignal();
    const result = await signal.waitAsync(10);
    expect(result).toBe('timed-out');
  });

  test('atomicSignalFromBuffer reconstructs', () => {
    const original = createAtomicSignal();
    const reconstructed = atomicSignalFromBuffer(original.buffer);
    original.notify();
    expect(reconstructed.peek()).toBe(true);
  });

  test('atomicSignalFromBuffer rejects wrong size', () => {
    expect(() => atomicSignalFromBuffer(new SharedArrayBuffer(8))).toThrow(RangeError);
  });

  test('dispose resets state', () => {
    const signal = createAtomicSignal();
    signal.notify();
    signal[Symbol.dispose]();
    expect(signal.peek()).toBe(false);
  });

  test('notify returns woken count', () => {
    const signal = createAtomicSignal();
    const count = signal.notify();
    expect(typeof count).toBe('number');
  });
});
