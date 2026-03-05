import { describe, test, expect } from 'bun:test';
import { scatter } from '../src/runtime/index.js';

describe('scatter.max()', () => {
  test('batch collect returns all results', async () => {
    const results = await scatter.max(
      (ctx: any, n: number) => n * 2,
      { inputs: [1, 2, 3, 4] },
    ).collect();

    expect(results.sort()).toEqual([2, 4, 6, 8]);
  });

  test('empty inputs returns empty array', async () => {
    const results = await scatter.max(
      (ctx: any, n: number) => n,
      { inputs: [] },
    ).collect();

    expect(results).toEqual([]);
  });

  test('single input works', async () => {
    const results = await scatter.max(
      (ctx: any, n: number) => n + 1,
      { inputs: [41] },
    ).collect();

    expect(results).toEqual([42]);
  });

  test('total reflects input count', () => {
    const result = scatter.max(
      (ctx: any, n: number) => n,
      { inputs: [1, 2, 3] },
    );

    expect(result.total).toBe(3);
    result.abort();
  });

  test('completed starts at 0', () => {
    const result = scatter.max(
      (ctx: any, n: number) => n,
      { inputs: [1, 2, 3] },
    );

    expect(result.completed).toBe(0);
    result.abort();
  });

  test('split overload works', async () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const results = await scatter.max(
      (ctx: any, chunk: number[]) => chunk.reduce((a: number, b: number) => a + b, 0),
      {
        input,
        split: (arr: number[], n: number) => {
          const chunks: number[][] = [];
          const chunkSize = Math.ceil(arr.length / n);
          for (let i = 0; i < arr.length; i += chunkSize) {
            chunks.push(arr.slice(i, i + chunkSize));
          }
          return chunks;
        },
      },
    ).collect();

    const total = results.reduce((a, b) => a + b, 0);
    expect(total).toBe(36); // 1+2+3+4+5+6+7+8
  });

  test('async iteration yields results', async () => {
    const result = scatter.max(
      (ctx: any, n: number) => n * 3,
      { inputs: [1, 2, 3] },
    );

    const values: number[] = [];
    for await (const v of result) {
      values.push(v);
    }

    expect(values.sort()).toEqual([3, 6, 9]);
  });

  test('abort stops iteration', async () => {
    const result = scatter.max(
      (ctx: any, n: number) => {
        const start = Date.now();
        while (Date.now() - start < 5000) {} // busy wait
        return n;
      },
      { inputs: [1, 2, 3, 4] },
    );

    // Abort after a short delay
    setTimeout(() => result.abort(), 100);

    const values: number[] = [];
    for await (const v of result) {
      values.push(v);
    }

    // Should have completed early
    expect(values.length).toBeLessThan(4);
  });

  test('non-function throws TypeError', () => {
    expect(() => {
      (scatter.max as any)(42, { inputs: [] });
    }).toThrow(TypeError);
  });
});
