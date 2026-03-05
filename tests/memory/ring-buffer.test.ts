import { describe, test, expect } from 'bun:test';
import { createRingBuffer, ringBufferFromBuffer } from '../../src/memory/ring-buffer.js';

describe('SharedRingBuffer', () => {
  test('push and pop single message', () => {
    const rb = createRingBuffer({ capacity: 1024 });
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    expect(rb.push(data)).toBe(true);
    const result = rb.pop();
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([1, 2, 3, 4, 5]);
  });

  test('pop returns null when empty', () => {
    const rb = createRingBuffer({ capacity: 256 });
    expect(rb.pop()).toBeNull();
  });

  test('push returns false when full', () => {
    const rb = createRingBuffer({ capacity: 16 });
    // 4-byte length prefix + 10 bytes = 14 bytes, fits in 16
    const data = new Uint8Array(10);
    expect(rb.push(data)).toBe(true);
    // Another push should fail (only 2 bytes left, need at least 5)
    expect(rb.push(new Uint8Array(1))).toBe(false);
  });

  test('variable size messages', () => {
    const rb = createRingBuffer({ capacity: 1024 });
    const small = new Uint8Array([1]);
    const medium = new Uint8Array(50).fill(42);
    const large = new Uint8Array(200).fill(99);

    expect(rb.push(small)).toBe(true);
    expect(rb.push(medium)).toBe(true);
    expect(rb.push(large)).toBe(true);

    expect(Array.from(rb.pop()!)).toEqual([1]);
    expect(rb.pop()!.every(b => b === 42)).toBe(true);
    expect(rb.pop()!.every(b => b === 99)).toBe(true);
  });

  test('wrap-around correctness', () => {
    const rb = createRingBuffer({ capacity: 32 });
    // Fill and drain to advance cursors near the boundary
    const msg1 = new Uint8Array(10).fill(1);
    rb.push(msg1); // 4+10 = 14 bytes
    rb.pop();       // read cursor advances 14

    const msg2 = new Uint8Array(10).fill(2);
    rb.push(msg2); // writes at offset 14, wraps around
    rb.pop();

    // Write message that straddles wrap boundary
    const msg3 = new Uint8Array(10).fill(3);
    expect(rb.push(msg3)).toBe(true);
    const result = rb.pop();
    expect(result).not.toBeNull();
    expect(result!.every(b => b === 3)).toBe(true);
    expect(result!.length).toBe(10);
  });

  test('pushBatch writes multiple', () => {
    const rb = createRingBuffer({ capacity: 1024 });
    const messages = [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      new Uint8Array([5, 6]),
    ];
    expect(rb.pushBatch(messages)).toBe(3);
    expect(Array.from(rb.pop()!)).toEqual([1, 2]);
    expect(Array.from(rb.pop()!)).toEqual([3, 4]);
    expect(Array.from(rb.pop()!)).toEqual([5, 6]);
  });

  test('pushBatch stops when full', () => {
    const rb = createRingBuffer({ capacity: 24 });
    const messages = [
      new Uint8Array(8),  // 4+8 = 12 bytes
      new Uint8Array(8),  // 4+8 = 12 bytes, total 24 = capacity
      new Uint8Array(8),  // won't fit
    ];
    expect(rb.pushBatch(messages)).toBe(2);
  });

  test('popBatch reads multiple', () => {
    const rb = createRingBuffer({ capacity: 1024 });
    rb.push(new Uint8Array([1]));
    rb.push(new Uint8Array([2]));
    rb.push(new Uint8Array([3]));
    const batch = rb.popBatch(10);
    expect(batch.length).toBe(3);
    expect(Array.from(batch[0])).toEqual([1]);
    expect(Array.from(batch[1])).toEqual([2]);
    expect(Array.from(batch[2])).toEqual([3]);
  });

  test('popBatch respects maxCount', () => {
    const rb = createRingBuffer({ capacity: 1024 });
    rb.push(new Uint8Array([1]));
    rb.push(new Uint8Array([2]));
    rb.push(new Uint8Array([3]));
    const batch = rb.popBatch(2);
    expect(batch.length).toBe(2);
  });

  test('close prevents further push', () => {
    const rb = createRingBuffer({ capacity: 256 });
    rb.close();
    expect(rb.push(new Uint8Array([1]))).toBe(false);
  });

  test('pop drains after close', () => {
    const rb = createRingBuffer({ capacity: 256 });
    rb.push(new Uint8Array([42]));
    rb.close();
    expect(rb.pop()).not.toBeNull();
    expect(rb.pop()).toBeNull();
  });

  test('closed getter reflects state', () => {
    const rb = createRingBuffer({ capacity: 256 });
    expect(rb.closed).toBe(false);
    rb.close();
    expect(rb.closed).toBe(true);
  });

  test('isEmpty reflects state', () => {
    const rb = createRingBuffer({ capacity: 256 });
    expect(rb.isEmpty).toBe(true);
    rb.push(new Uint8Array([1]));
    expect(rb.isEmpty).toBe(false);
    rb.pop();
    expect(rb.isEmpty).toBe(true);
  });

  test('available and pending', () => {
    const rb = createRingBuffer({ capacity: 256 });
    expect(rb.available()).toBe(256);
    expect(rb.pending()).toBe(0);
    rb.push(new Uint8Array(10)); // 14 bytes total
    expect(rb.pending()).toBe(14);
    expect(rb.available()).toBe(242);
  });

  test('capacity matches option', () => {
    const rb = createRingBuffer({ capacity: 4096 });
    expect(rb.capacity).toBe(4096);
  });

  test('ringBufferFromBuffer reconstructs', () => {
    const rb = createRingBuffer({ capacity: 256 });
    rb.push(new Uint8Array([1, 2, 3]));
    const rb2 = ringBufferFromBuffer(rb.buffer);
    const result = rb2.pop();
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([1, 2, 3]);
  });

  test('ringBufferFromBuffer rejects too-small buffer', () => {
    expect(() => ringBufferFromBuffer(new SharedArrayBuffer(8))).toThrow(RangeError);
  });

  test('createRingBuffer rejects invalid capacity', () => {
    expect(() => createRingBuffer({ capacity: -1 })).toThrow(RangeError);
    expect(() => createRingBuffer({ capacity: 0 })).toThrow(RangeError);
    expect(() => createRingBuffer({ capacity: 1.5 })).toThrow(RangeError);
  });

  test('dispose calls close', () => {
    const rb = createRingBuffer({ capacity: 256 });
    rb[Symbol.dispose]();
    expect(rb.closed).toBe(true);
  });

  test('default capacity is 65536', () => {
    const rb = createRingBuffer();
    expect(rb.capacity).toBe(65536);
  });
});
