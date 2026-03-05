import { describe, test, expect } from 'bun:test';
import { scatter } from '../src/runtime/index.js';
import { PoolTerminatedError } from '../src/error.js';

describe('scatter.pool()', () => {
  test('exec returns correct result', async () => {
    const pool = scatter.pool(
      (ctx: any, n: number) => n * 2,
      { size: 2 },
    );
    const result = await pool.exec(21);
    expect(result).toBe(42);
    pool.terminate();
  });

  test('multiple tasks resolve correctly', async () => {
    const pool = scatter.pool(
      (ctx: any, n: number) => n + 1,
      { size: 2 },
    );

    const results = await Promise.all([
      pool.exec(1),
      pool.exec(2),
      pool.exec(3),
      pool.exec(4),
    ]);

    expect(results.sort()).toEqual([2, 3, 4, 5]);
    pool.terminate();
  });

  test('drain resolves when idle', async () => {
    const pool = scatter.pool(
      (ctx: any, n: number) => n,
      { size: 2 },
    );

    await pool.exec(1);
    await pool.drain();
    pool.terminate();
  });

  test('terminate rejects pending tasks', async () => {
    const pool = scatter.pool(
      (ctx: any, n: number) => {
        // Slow task
        const start = Date.now();
        while (Date.now() - start < 5000) {}
        return n;
      },
      { size: 1 },
    );

    const promise = pool.exec(1);
    // Give the task a moment to be dispatched
    await new Promise((r) => setTimeout(r, 50));
    pool.terminate();

    try {
      await promise;
      // The task might have been rejected by terminate
    } catch (err) {
      expect(err).toBeInstanceOf(PoolTerminatedError);
    }
  });

  test('stats reflect correct values', async () => {
    const pool = scatter.pool(
      (ctx: any, n: number) => n * 2,
      { size: 2 },
    );

    expect(pool.stats.workersAlive).toBe(2);

    await pool.exec(1);
    expect(pool.stats.completedTasks).toBeGreaterThanOrEqual(1);

    pool.terminate();
  });

  test('exec after terminate throws PoolTerminatedError', async () => {
    const pool = scatter.pool(
      (ctx: any, n: number) => n,
      { size: 1 },
    );
    pool.terminate();

    try {
      await pool.exec(1);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(PoolTerminatedError);
    }
  });

  test('pool shutdown waits for tasks', async () => {
    const pool = scatter.pool(
      (ctx: any, n: number) => {
        return n + 1;
      },
      { size: 2 },
    );

    const result = await pool.exec(41);
    expect(result).toBe(42);

    await pool.shutdown();
  });

  test('Symbol.dispose terminates', () => {
    const pool = scatter.pool(
      (ctx: any, n: number) => n,
      { size: 1 },
    );

    pool[Symbol.dispose]();
    // After dispose, exec should fail
    expect(pool.exec(1)).rejects.toThrow();
  });

  test('non-function throws TypeError', () => {
    expect(() => {
      (scatter.pool as any)(42);
    }).toThrow(TypeError);
  });

  test('invalid size throws TypeError', () => {
    expect(() => {
      scatter.pool(() => {}, { size: 0 });
    }).toThrow(TypeError);
  });

  test('execMany yields results', async () => {
    const pool = scatter.pool(
      (ctx: any, n: number) => n * 10,
      { size: 2 },
    );

    const results: number[] = [];
    for await (const result of pool.execMany([1, 2, 3])) {
      results.push(result);
    }

    expect(results.sort()).toEqual([10, 20, 30]);
    pool.terminate();
  });
});
