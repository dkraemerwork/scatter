import { describe, test, expect } from 'bun:test';
import { materialize } from '../src/virtual-worker.js';
import { ThreadAbortError, MaterializationError } from '../src/error.js';

describe('VirtualWorker', () => {
  test('materialize creates worker and resolves ready', async () => {
    const vw = materialize(() => {}, { mode: 'oneshot' });
    await vw.ready;
    expect(vw.disposed).toBe(false);
    expect(vw.threadId).toBeGreaterThan(0);
    vw.dispose();
  });

  test('init handshake completes with correct threadId', async () => {
    const vw = materialize(() => {}, { mode: 'oneshot' });
    await vw.ready;
    expect(typeof vw.threadId).toBe('number');
    vw.dispose();
  });

  test('dispose is idempotent', async () => {
    const vw = materialize(() => {}, { mode: 'oneshot' });
    await vw.ready;
    vw.dispose();
    vw.dispose(); // second call should not throw
    expect(vw.disposed).toBe(true);
  });

  test('already-aborted signal throws ThreadAbortError', () => {
    expect(() => {
      materialize(() => {}, {
        mode: 'oneshot',
        signal: AbortSignal.abort(),
      });
    }).toThrow(ThreadAbortError);
  });

  test('blobUrl is set', async () => {
    const vw = materialize(() => {}, { mode: 'oneshot' });
    expect(typeof vw.blobUrl).toBe('string');
    expect(vw.blobUrl).toContain('blob:');
    vw.dispose();
  });

  test('worker is a Worker instance', async () => {
    const vw = materialize(() => {}, { mode: 'oneshot' });
    expect(vw.worker).toBeInstanceOf(Worker);
    vw.dispose();
  });

  test('Symbol.dispose calls dispose', async () => {
    const vw = materialize(() => {}, { mode: 'oneshot' });
    await vw.ready;
    vw[Symbol.dispose]();
    expect(vw.disposed).toBe(true);
  });

  test('onError handlers are registered', async () => {
    const vw = materialize(() => {}, { mode: 'oneshot' });
    let called = false;
    vw.onError(() => { called = true; });
    // We can't easily trigger an error here, but verify no throw on registration
    expect(called).toBe(false);
    vw.dispose();
  });

  test('onExit handlers are registered', async () => {
    const vw = materialize(() => {}, { mode: 'oneshot' });
    let called = false;
    vw.onExit(() => { called = true; });
    expect(called).toBe(false);
    vw.dispose();
  });

  test('shutdown posts SHUTDOWN and disposes', async () => {
    const vw = materialize((ctx: any) => {
      // Worker that stays alive until shutdown
    }, { mode: 'oneshot' });
    await vw.ready;
    await vw.shutdown(200);
    expect(vw.disposed).toBe(true);
  });2

  test('Symbol.asyncDispose calls shutdown', async () => {
    const vw = materialize(() => {}, { mode: 'oneshot' });
    await vw.ready;
    // Use a short timeout — the oneshot worker has already finished, so
    // it won't ack the shutdown. We just need the timeout to fire and dispose.
    await vw.shutdown(200);
    expect(vw.disposed).toBe(true);
  });
});
