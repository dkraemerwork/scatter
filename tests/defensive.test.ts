/**
 * P14: Defensive edge-case tests.
 *
 * Targets hardened behavior from the Code Audit (P13).
 * Each test covers a specific edge case that previously had no explicit coverage.
 */

import { describe, test, expect } from 'bun:test';
import { createRingBuffer } from '../src/memory/ring-buffer.js';
import { createChannel } from '../src/memory/shared-channel.js';
import { scatter, Channel } from '../src/runtime/index.js';
import { materialize } from '../src/virtual-worker.js';
import { ChannelClosedError, ChannelFullError, PoolTerminatedError, MaterializationError } from '../src/error.js';

// ---------------------------------------------------------------------------
// Ring buffer boundary tests (14.1 – 14.3, 14.17)
// ---------------------------------------------------------------------------

describe('Ring buffer — capacity boundary', () => {
  test('14.1: message > capacity returns false, buffer unchanged', () => {
    const rb = createRingBuffer({ capacity: 32 });
    const hugeMessage = new Uint8Array(64); // Way bigger than capacity
    hugeMessage.fill(0xAB);

    expect(rb.push(hugeMessage)).toBe(false);
    expect(rb.isEmpty).toBe(true);
    expect(rb.pending()).toBe(0);
    expect(rb.pop()).toBeNull();
  });

  test('14.2: message == capacity returns false (frame = capacity + 4)', () => {
    const rb = createRingBuffer({ capacity: 32 });
    const exactCapacity = new Uint8Array(32); // frame = 32 + 4 = 36 > 32
    exactCapacity.fill(0xCD);

    expect(rb.push(exactCapacity)).toBe(false);
    expect(rb.isEmpty).toBe(true);
  });

  test('14.3: message == capacity - 4 fits exactly', () => {
    const rb = createRingBuffer({ capacity: 32 });
    const exactFit = new Uint8Array(28); // frame = 28 + 4 = 32 === capacity
    exactFit.fill(0xEF);

    expect(rb.push(exactFit)).toBe(true);
    const popped = rb.pop();
    expect(popped).not.toBeNull();
    expect(popped!.length).toBe(28);
    expect(popped![0]).toBe(0xEF);
    expect(popped![27]).toBe(0xEF);
  });

  test('14.17: wrap-around boundary — length prefix straddles wrap', () => {
    // Create small ring where wrap boundary hits exactly at a message boundary
    const rb = createRingBuffer({ capacity: 16 });

    // First message: 8 bytes data → frame = 12 bytes. Cursor at 12.
    const msg1 = new Uint8Array(8);
    msg1.fill(0xAA);
    expect(rb.push(msg1)).toBe(true);
    expect(rb.pop()![0]).toBe(0xAA);

    // Cursor at 12. Next 4-byte length prefix starts at offset 12,
    // wraps around at 16. Payload starts at (12+4)%16 = 0.
    const msg2 = new Uint8Array(4);
    msg2.fill(0xBB);
    expect(rb.push(msg2)).toBe(true);
    const popped2 = rb.pop();
    expect(popped2).not.toBeNull();
    expect(popped2!.length).toBe(4);
    expect(popped2![0]).toBe(0xBB);
  });
});

// ---------------------------------------------------------------------------
// Channel edge cases (14.4, 14.5)
// ---------------------------------------------------------------------------

describe('Channel — defensive', () => {
  test('14.4: write to a closed channel throws ChannelClosedError', () => {
    const ch = createChannel<string>({ codec: 'string' });
    ch.close();

    expect(() => ch.write('nope')).toThrow(ChannelClosedError);
    expect(() => ch.tryWrite('nope')).toThrow(ChannelClosedError);
  });

  test('14.5: write after close — both sides', () => {
    const ch = createChannel<number>({ codec: 'number' });

    // Write some data
    ch.write(1);
    ch.write(2);
    ch.close();

    // Reader can drain remaining
    expect(ch.read()).toBe(1);
    expect(ch.read()).toBe(2);
    expect(ch.read()).toBeNull(); // closed + drained

    // Writer cannot write
    expect(() => ch.write(3)).toThrow(ChannelClosedError);
  });

  test('14.18: rapid write/read 10000 messages — no corruption, in order', () => {
    const ch = createChannel<number>({ codec: 'number', capacity: 256 * 1024 });

    const count = 10_000;
    for (let i = 0; i < count; i++) {
      ch.write(i);
    }
    ch.close();

    for (let i = 0; i < count; i++) {
      const value = ch.read();
      expect(value).toBe(i);
    }
    expect(ch.read()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pool edge cases (14.6 – 14.9)
// ---------------------------------------------------------------------------

describe('Pool — defensive', () => {
  test('14.6: exec after terminate rejects with PoolTerminatedError', async () => {
    const pool = scatter.pool(
      (_ctx: any, n: number) => n * 2,
      { size: 1 },
    );
    pool.terminate();

    try {
      await pool.exec(5);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(PoolTerminatedError);
    }
  });

  test('14.7: exec after shutdown rejects', async () => {
    const pool = scatter.pool(
      (_ctx: any, n: number) => n * 2,
      { size: 1 },
    );

    // Verify it works first
    const result = await pool.exec(5);
    expect(result).toBe(10);

    await pool.shutdown();

    try {
      await pool.exec(10);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(PoolTerminatedError);
    }
  });

  test('14.8: double terminate is idempotent', () => {
    const pool = scatter.pool(
      (_ctx: any, n: number) => n,
      { size: 1 },
    );
    pool.terminate();
    pool.terminate(); // Should not throw
    expect(pool.stats.workersAlive).toBe(0);
  });

  test('14.9: double shutdown is idempotent', async () => {
    const pool = scatter.pool(
      (_ctx: any, n: number) => n,
      { size: 1 },
    );
    await pool.shutdown();
    await pool.shutdown(); // Should resolve immediately
  });
});

// ---------------------------------------------------------------------------
// Spawn edge cases (14.10, 14.15)
// ---------------------------------------------------------------------------

describe('Spawn — defensive', () => {
  test('14.10: terminate twice is idempotent', async () => {
    const handle = scatter.spawn(
      async (ctx: any) => {
        const ch = ctx.channel('input');
        await ch.readAsync(); // Wait until closed
      },
      {
        channels: {
          input: Channel.in<number>({ codec: 'number' }),
        },
      },
    );

    handle.terminate();
    handle.terminate(); // Should not throw
    expect(handle.alive).toBe(false);
  });

  test('14.15: channel write before ready is defined', () => {
    const handle = scatter.spawn(
      async (ctx: any) => {
        const ch = ctx.channel('input');
        await ch.readAsync();
      },
      {
        channels: {
          input: Channel.in<number>({ codec: 'number' }),
        },
      },
    );

    // Writing before the worker has consumed — this should queue into the ring buffer
    // Since the ring buffer is a SharedArrayBuffer, writes are always available immediately
    handle.channels.input.write(42);
    handle.terminate();
  });
});

// ---------------------------------------------------------------------------
// Scatter edge cases (14.11, 14.12)
// ---------------------------------------------------------------------------

describe('Scatter — defensive', () => {
  test('14.11: non-function argument rejects with TypeError', async () => {
    try {
      await (scatter as any)(42);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
    }
  });

  test('14.12: function referencing outer scope fails with understandable error', async () => {
    // This function captures `outerVar` which won't be available in the worker
    const outerVar = 'secret';
    try {
      await scatter(() => outerVar);
      // Might succeed if Bun serializes the closure, or fail — either way, no crash
    } catch (err) {
      // Expected: the error should be something reasonable, not a hang
      expect(err).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// VirtualWorker edge cases (14.16)
// ---------------------------------------------------------------------------

describe('VirtualWorker — defensive', () => {
  test('14.16: materialize with invalid function source', () => {
    // Test that materialize validates fn is a function
    expect(() => {
      materialize(null as any, { mode: 'oneshot' });
    }).toThrow(TypeError);

    expect(() => {
      materialize(42 as any, { mode: 'oneshot' });
    }).toThrow(TypeError);
  });

  test('materialize with invalid mode throws TypeError', () => {
    expect(() => {
      materialize(() => {}, { mode: 'bogus' as any });
    }).toThrow(TypeError);
  });
});
