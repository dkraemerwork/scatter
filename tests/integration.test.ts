import { describe, test, expect } from 'bun:test';
import { scatter, Channel } from '../src/runtime/index.js';
import { ThreadExecutionError } from '../src/error.js';

describe('Integration Tests', () => {
  test('CPU-bound one-shot: fibonacci', async () => {
    const result = await scatter((ctx) => {
      function fib(n: number): number {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
      return fib(20);
    });
    expect(result).toBe(6765);
  });

  test('data passing round-trip', async () => {
    const result = await scatter(
      (ctx) => {
        const items = ctx.data.items as number[];
        return items.reduce((a, b) => a + b, 0);
      },
      { data: { items: [1, 2, 3, 4, 5] } },
    );
    expect(result).toBe(15);
  });

  test('pool throughput: 20 tasks across 2 workers', async () => {
    const pool = scatter.pool(
      (ctx: any, n: number) => n * n,
      { size: 2 },
    );

    const promises: Promise<number>[] = [];
    for (let i = 1; i <= 20; i++) {
      promises.push(pool.exec(i));
    }

    const results = await Promise.all(promises);
    for (let i = 0; i < 20; i++) {
      expect(results[i]).toBe((i + 1) * (i + 1));
    }

    pool.terminate();
  });

  test('error propagation from scatter()', async () => {
    try {
      await scatter(() => {
        throw new TypeError('type error from worker');
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ThreadExecutionError);
      expect((err as ThreadExecutionError).originalName).toBe('TypeError');
    }
  });

  test('error propagation from pool', async () => {
    const pool = scatter.pool(
      (ctx: any, n: number) => {
        if (n < 0) throw new Error('negative!');
        return n;
      },
      { size: 1 },
    );

    const good = await pool.exec(5);
    expect(good).toBe(5);

    try {
      await pool.exec(-1);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ThreadExecutionError);
    }

    pool.terminate();
  });

  test('scatter.max with batch and collect', async () => {
    const results = await scatter.max(
      (ctx: any, nums: number[]) => nums.reduce((a: number, b: number) => a + b, 0),
      { inputs: [[1, 2], [3, 4], [5, 6]] },
    ).collect();

    expect(results.sort((a, b) => a - b)).toEqual([3, 7, 11]);
  });

  test('spawn streaming pipeline', async () => {
    const handle = scatter.spawn(
      async (ctx: any) => {
        const input = ctx.channel('input');
        const output = ctx.channel('output');

        while (true) {
          const value = await input.readAsync();
          if (value === null) break;
          output.write(value * 2);
        }
        output.close();
      },
      {
        channels: {
          input: Channel.in<number>({ codec: 'number' }),
          output: Channel.out<number>({ codec: 'number' }),
        },
      },
    );

    // Write 10 values
    for (let i = 1; i <= 10; i++) {
      handle.channels.input.write(i);
    }
    handle.channels.input.close();

    // Read 10 results
    const results: number[] = [];
    for await (const value of handle.channels.output) {
      results.push(value);
    }

    expect(results.length).toBe(10);
    expect(results.sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    handle.terminate();
  });
});
