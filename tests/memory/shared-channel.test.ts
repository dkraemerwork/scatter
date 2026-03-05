import { describe, test, expect } from 'bun:test';
import { createChannel, channelFromMeta } from '../../src/memory/shared-channel.js';
import { ChannelClosedError, ChannelFullError } from '../../src/error.js';

describe('SharedChannel', () => {
  test('write and read round-trip with structured codec', () => {
    const ch = createChannel<{ value: number }>({ codec: 'structured' });
    ch.write({ value: 42 });
    expect(ch.read()).toEqual({ value: 42 });
  });

  test('write and read with number codec', () => {
    const ch = createChannel<number>({ codec: 'number' });
    ch.write(3.14);
    const result = ch.read();
    expect(result).toBeCloseTo(3.14);
  });

  test('write and read with string codec', () => {
    const ch = createChannel<string>({ codec: 'string' });
    ch.write('hello world');
    expect(ch.read()).toBe('hello world');
  });

  test('write and read with json codec', () => {
    const ch = createChannel({ codec: 'json' });
    ch.write({ nested: [1, 2, 3] });
    expect(ch.read()).toEqual({ nested: [1, 2, 3] });
  });

  test('write and read with raw codec', () => {
    const ch = createChannel<Uint8Array>({ codec: 'raw' });
    ch.write(new Uint8Array([1, 2, 3]));
    const result = ch.read();
    expect(Array.from(result!)).toEqual([1, 2, 3]);
  });

  test('read returns null when empty', () => {
    const ch = createChannel({ codec: 'json' });
    expect(ch.read()).toBeNull();
  });

  test('tryWrite returns true when space available', () => {
    const ch = createChannel({ codec: 'number' });
    expect(ch.tryWrite(42)).toBe(true);
  });

  test('tryWrite returns false when full', () => {
    const ch = createChannel<Uint8Array>({ codec: 'raw', capacity: 16 });
    ch.write(new Uint8Array(10)); // 4+10=14 bytes
    expect(ch.tryWrite(new Uint8Array(10))).toBe(false);
  });

  test('write throws ChannelFullError when full', () => {
    const ch = createChannel<Uint8Array>({ codec: 'raw', capacity: 16 });
    ch.write(new Uint8Array(10));
    expect(() => ch.write(new Uint8Array(10))).toThrow(ChannelFullError);
  });

  test('write throws ChannelClosedError after close', () => {
    const ch = createChannel({ codec: 'json' });
    ch.close();
    expect(() => ch.write({ test: true })).toThrow(ChannelClosedError);
  });

  test('close sets closed flag', () => {
    const ch = createChannel({ codec: 'json' });
    expect(ch.closed).toBe(false);
    ch.close();
    expect(ch.closed).toBe(true);
  });

  test('read drains after close', () => {
    const ch = createChannel<number>({ codec: 'number' });
    ch.write(1);
    ch.write(2);
    ch.close();
    expect(ch.read()).toBe(1);
    expect(ch.read()).toBe(2);
    expect(ch.read()).toBeNull();
  });

  test('readBatch reads up to N values', () => {
    const ch = createChannel<number>({ codec: 'number' });
    ch.write(1);
    ch.write(2);
    ch.write(3);
    const batch = ch.readBatch(2);
    expect(batch).toEqual([1, 2]);
    expect(ch.read()).toBe(3);
  });

  test('readBatch returns empty when nothing available', () => {
    const ch = createChannel({ codec: 'json' });
    expect(ch.readBatch(10)).toEqual([]);
  });

  test('writeBlocking returns true when space available', () => {
    const ch = createChannel<number>({ codec: 'number' });
    expect(ch.writeBlocking(42, 100)).toBe(true);
    expect(ch.read()).toBe(42);
  });

  test('readBlocking returns value immediately when available', () => {
    const ch = createChannel<number>({ codec: 'number' });
    ch.write(99);
    expect(ch.readBlocking(100)).toBe(99);
  });

  test('readBlocking returns null after close and drain', () => {
    const ch = createChannel<number>({ codec: 'number' });
    ch.close();
    expect(ch.readBlocking(50)).toBeNull();
  });

  test('readAsync resolves with value', async () => {
    const ch = createChannel<number>({ codec: 'number' });
    ch.write(77);
    const result = await ch.readAsync();
    expect(result).toBe(77);
  });

  test('readAsync returns null when closed and drained', async () => {
    const ch = createChannel<number>({ codec: 'number' });
    ch.close();
    const result = await ch.readAsync();
    expect(result).toBeNull();
  });

  test('asyncIterator yields values then completes on close', async () => {
    const ch = createChannel<number>({ codec: 'number' });
    ch.write(1);
    ch.write(2);
    ch.write(3);

    // Close after a short delay so the iterator can drain
    setTimeout(() => ch.close(), 50);

    const values: number[] = [];
    for await (const value of ch) {
      values.push(value);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  test('channelFromMeta reconstructs working channel', () => {
    const ch = createChannel<string>({ codec: 'string', capacity: 1024 });
    ch.write('hello');

    const ch2 = channelFromMeta<string>(ch.meta);
    expect(ch2.read()).toBe('hello');

    ch2.write('world');
    expect(ch.read()).toBe('world');
  });

  test('meta contains correct properties', () => {
    const ch = createChannel<number>({ codec: 'number', capacity: 4096 });
    const meta = ch.meta;
    expect(meta.ringSab).toBeInstanceOf(SharedArrayBuffer);
    expect(meta.signalSab).toBeInstanceOf(SharedArrayBuffer);
    expect(meta.capacity).toBe(4096);
    expect(meta.codecName).toBe('number');
  });

  test('transferables contain SABs', () => {
    const ch = createChannel({ codec: 'json' });
    expect(ch.transferables.ring).toBeInstanceOf(SharedArrayBuffer);
    expect(ch.transferables.signal).toBeInstanceOf(SharedArrayBuffer);
  });

  test('dispose calls close', () => {
    const ch = createChannel({ codec: 'json' });
    ch[Symbol.dispose]();
    expect(ch.closed).toBe(true);
  });

  test('default codec is structured', () => {
    const ch = createChannel();
    ch.write({ test: true });
    expect(ch.read()).toEqual({ test: true });
  });

  test('default capacity is 65536', () => {
    const ch = createChannel();
    expect(ch.meta.capacity).toBe(65536);
  });
});
