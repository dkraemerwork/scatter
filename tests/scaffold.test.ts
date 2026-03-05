import { describe, test, expect } from 'bun:test';
import { generateScaffold } from '../src/scaffold.js';

describe('generateScaffold', () => {
  const fnSource = '(ctx) => ctx.data.x * 2';

  test('returns string for each mode', () => {
    for (const mode of ['oneshot', 'spawn', 'pool', 'max'] as const) {
      const source = generateScaffold({ fnSource, imports: [], mode });
      expect(typeof source).toBe('string');
      expect(source.length).toBeGreaterThan(100);
    }
  });

  test('source contains the user function', () => {
    const source = generateScaffold({ fnSource, imports: [], mode: 'oneshot' });
    expect(source).toContain(fnSource);
  });

  test('source contains INIT_ACK posting', () => {
    for (const mode of ['oneshot', 'spawn', 'pool', 'max'] as const) {
      const source = generateScaffold({ fnSource, imports: [], mode });
      expect(source).toContain('__SCATTER_INIT_ACK__');
    }
  });

  test('oneshot source does not call self.close() (host-side terminate)', () => {
    const source = generateScaffold({ fnSource, imports: [], mode: 'oneshot' });
    expect(source).not.toContain('self.close()');
    // The worker relies on host-side worker.terminate() for cleanup,
    // avoiding a Bun bug where self.close() prevents subsequent workers.
  });

  test('spawn source reconstructs channels', () => {
    const source = generateScaffold({ fnSource, imports: [], mode: 'spawn' });
    expect(source).toContain('__channelFromMeta');
    expect(source).toContain('channelMeta');
  });

  test('pool source handles TASK messages', () => {
    const source = generateScaffold({ fnSource, imports: [], mode: 'pool' });
    expect(source).toContain('__SCATTER_TASK__');
    expect(source).toContain('__SCATTER_TASK_RESULT__');
  });

  test('pool concurrent source has semaphore', () => {
    const source = generateScaffold({
      fnSource,
      imports: [],
      mode: 'pool',
      concurrency: 4,
    });
    expect(source).toContain('__CONCURRENCY');
    expect(source).toContain('4'); // the concurrency value
  });

  test('imports are injected at top', () => {
    const source = generateScaffold({
      fnSource,
      imports: ['import { foo } from "bar";'],
      mode: 'oneshot',
    });
    // Import should appear before the function
    const importIdx = source.indexOf('import { foo }');
    const fnIdx = source.indexOf('const __fn');
    expect(importIdx).toBeLessThan(fnIdx);
  });

  test('source contains error serialization helper', () => {
    const source = generateScaffold({ fnSource, imports: [], mode: 'oneshot' });
    expect(source).toContain('__serializeError');
  });

  test('source contains unhandledrejection listener', () => {
    const source = generateScaffold({ fnSource, imports: [], mode: 'oneshot' });
    expect(source).toContain('unhandledrejection');
  });

  test('source contains codec resolution', () => {
    const source = generateScaffold({ fnSource, imports: [], mode: 'spawn' });
    expect(source).toContain('__resolveCodec');
  });

  test('pool sequential mode for concurrency=1', () => {
    const source = generateScaffold({ fnSource, imports: [], mode: 'pool', concurrency: 1 });
    expect(source).not.toContain('__CONCURRENCY');
    expect(source).toContain('__SCATTER_TASK__');
  });

  test('max mode generates pool-like code', () => {
    const source = generateScaffold({ fnSource, imports: [], mode: 'max' });
    expect(source).toContain('__SCATTER_TASK__');
    expect(source).toContain('__SCATTER_INIT_ACK__');
  });
});
