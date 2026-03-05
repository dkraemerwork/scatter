import { describe, expect, test } from 'bun:test';
import { serializeState, isSerializable } from '../../src/decorators/serialize-state.js';

describe('serializeState', () => {
  test('SS.1: mixed-field class instance — keeps serializable, drops non-serializable', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const instance = {
      // Serializable (7)
      name: 'test',
      count: 42,
      createdAt: new Date('2024-01-01'),
      buffer: new Uint8Array([1, 2, 3]),
      map: new Map([['a', 1]]),
      set: new Set([1, 2, 3]),
      pattern: /foo/gi,

      // Circular refs survive structuredClone, so they are serializable
      circular,

      // Non-serializable (5)
      callback: () => 'hello',
      sym: Symbol('test'),
      missing: undefined,
      weak: new WeakMap(),
      weakRef: new WeakRef({}),
    };

    const result = serializeState(instance);

    // All 8 serializable fields present
    expect(result.name).toBe('test');
    expect(result.count).toBe(42);
    expect(result.createdAt).toEqual(new Date('2024-01-01'));
    expect(result.buffer).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.map).toEqual(new Map([['a', 1]]));
    expect(result.set).toEqual(new Set([1, 2, 3]));
    expect(result.pattern).toEqual(/foo/gi);
    expect(result.circular).toHaveProperty('a', 1);

    // All 5 non-serializable fields absent
    expect(result).not.toHaveProperty('callback');
    expect(result).not.toHaveProperty('sym');
    expect(result).not.toHaveProperty('missing');
    expect(result).not.toHaveProperty('weak');
    expect(result).not.toHaveProperty('weakRef');

    // Exactly 8 keys
    expect(Object.keys(result)).toHaveLength(8);
  });

  test('SS.2: empty and trivial inputs', () => {
    // Empty object returns empty
    expect(serializeState({})).toEqual({});

    // Only non-serializable fields returns empty
    expect(serializeState({ fn: () => {}, sym: Symbol() })).toEqual({});

    // Single primitive field
    expect(serializeState({ x: 42 })).toEqual({ x: 42 });
  });
});
