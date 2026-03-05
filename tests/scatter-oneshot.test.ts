import { describe, test, expect, afterAll } from 'bun:test';
import { scatter } from '../src/runtime/index.js';
import { ThreadExecutionError, ThreadTimeoutError, ThreadAbortError } from '../src/error.js';

describe('scatter() — oneshot', () => {
  test('returns computed value', async () => {
    const result = await scatter(() => 1 + 1);
    expect(result).toBe(2);
  });

  test('receives ctx.data', async () => {
    const result = await scatter(
      (ctx) => (ctx.data.x as number) * 2,
      { data: { x: 21 } },
    );
    expect(result).toBe(42);
  });

  test('worker function throw rejects with ThreadExecutionError', async () => {
    try {
      await scatter(() => { throw new Error('boom'); });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ThreadExecutionError);
      expect((err as ThreadExecutionError).originalName).toBe('Error');
      expect((err as ThreadExecutionError).message).toBe('boom');
    }
  });

  test('timeout rejects with ThreadTimeoutError', async () => {
    try {
      await scatter(
        () => {
          // Busy-wait instead of setTimeout to avoid timer leak
          const end = Date.now() + 10000;
          while (Date.now() < end) {}
          return 'should not reach';
        },
        { timeout: 100 },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ThreadTimeoutError);
    }
  });

  test('already-aborted signal rejects with ThreadAbortError', async () => {
    try {
      await scatter(
        () => 42,
        { signal: AbortSignal.abort() },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ThreadAbortError);
    }
  });

  test('Bun globals available in worker', async () => {
    const version = await scatter(() => typeof Bun !== 'undefined');
    expect(version).toBe(true);
  });

  test('async worker function', async () => {
    const result = await scatter(async () => {
      return 'async result';
    });
    expect(result).toBe('async result');
  });

  test('non-function argument rejects with TypeError', async () => {
    try {
      await (scatter as any)(42);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
    }
  });

  test('error cause chain is preserved', async () => {
    try {
      await scatter(() => {
        throw new Error('outer', { cause: new Error('inner') });
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ThreadExecutionError);
      expect((err as ThreadExecutionError).cause).toBeDefined();
    }
  });
});
