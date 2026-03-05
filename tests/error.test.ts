import { describe, test, expect } from 'bun:test';
import {
  ScatterError,
  ThreadExecutionError,
  ThreadTimeoutError,
  ThreadAbortError,
  WorkerCrashedError,
  MaterializationError,
  ChannelClosedError,
  ChannelFullError,
  PoolTerminatedError,
  serializeError,
  reconstructError,
} from '../src/error.js';

describe('Error Hierarchy', () => {
  test('all errors extend ScatterError', () => {
    expect(new ThreadExecutionError('msg', 'Error', 'stack')).toBeInstanceOf(ScatterError);
    expect(new ThreadTimeoutError(1000)).toBeInstanceOf(ScatterError);
    expect(new ThreadAbortError()).toBeInstanceOf(ScatterError);
    expect(new WorkerCrashedError(1)).toBeInstanceOf(ScatterError);
    expect(new MaterializationError('msg')).toBeInstanceOf(ScatterError);
    expect(new ChannelClosedError()).toBeInstanceOf(ScatterError);
    expect(new ChannelFullError(1000)).toBeInstanceOf(ScatterError);
    expect(new PoolTerminatedError()).toBeInstanceOf(ScatterError);
  });

  test('all errors extend Error', () => {
    expect(new ThreadExecutionError('msg', 'Error', 'stack')).toBeInstanceOf(Error);
    expect(new ThreadTimeoutError(1000)).toBeInstanceOf(Error);
  });

  test('ThreadExecutionError has correct properties', () => {
    const err = new ThreadExecutionError('something broke', 'TypeError', 'TypeError: something broke\n  at ...');
    expect(err.name).toBe('ThreadExecutionError');
    expect(err._tag).toBe('ThreadExecutionError');
    expect(err.message).toBe('something broke');
    expect(err.originalName).toBe('TypeError');
    expect(err.originalStack).toContain('TypeError');
  });

  test('ThreadTimeoutError has timeout value', () => {
    const err = new ThreadTimeoutError(5000);
    expect(err.name).toBe('ThreadTimeoutError');
    expect(err._tag).toBe('ThreadTimeoutError');
    expect(err.timeout).toBe(5000);
    expect(err.message).toContain('5000');
  });

  test('ThreadAbortError', () => {
    const err = new ThreadAbortError();
    expect(err.name).toBe('ThreadAbortError');
    expect(err._tag).toBe('ThreadAbortError');
  });

  test('WorkerCrashedError with exit code', () => {
    const err = new WorkerCrashedError(137);
    expect(err.name).toBe('WorkerCrashedError');
    expect(err._tag).toBe('WorkerCrashedError');
    expect(err.exitCode).toBe(137);
    expect(err.message).toContain('137');
  });

  test('WorkerCrashedError with null exit code', () => {
    const err = new WorkerCrashedError(null);
    expect(err.exitCode).toBeNull();
  });

  test('MaterializationError', () => {
    const err = new MaterializationError('failed to create blob');
    expect(err.name).toBe('MaterializationError');
    expect(err._tag).toBe('MaterializationError');
    expect(err.message).toBe('failed to create blob');
  });

  test('ChannelClosedError', () => {
    const err = new ChannelClosedError();
    expect(err.name).toBe('ChannelClosedError');
    expect(err._tag).toBe('ChannelClosedError');
  });

  test('ChannelFullError', () => {
    const err = new ChannelFullError(500);
    expect(err.name).toBe('ChannelFullError');
    expect(err._tag).toBe('ChannelFullError');
    expect(err.timeout).toBe(500);
  });

  test('PoolTerminatedError', () => {
    const err = new PoolTerminatedError();
    expect(err.name).toBe('PoolTerminatedError');
    expect(err._tag).toBe('PoolTerminatedError');
  });
});

describe('serializeError', () => {
  test('serializes Error', () => {
    const err = new Error('test error');
    const serialized = serializeError(err);
    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('test error');
    expect(typeof serialized.stack).toBe('string');
  });

  test('serializes Error with cause chain', () => {
    const inner = new Error('inner');
    const outer = new Error('outer', { cause: inner });
    const serialized = serializeError(outer);
    expect(serialized.message).toBe('outer');
    expect(serialized.cause).toBeDefined();
    expect(serialized.cause!.message).toBe('inner');
  });

  test('max depth 10', () => {
    let err: Error = new Error('base');
    for (let i = 0; i < 15; i++) {
      err = new Error(`level-${i}`, { cause: err });
    }
    const serialized = serializeError(err);
    // Walk the chain
    let depth = 0;
    let current = serialized;
    while (current.cause) {
      depth++;
      current = current.cause;
    }
    expect(depth).toBeLessThanOrEqual(10);
  });

  test('serializes non-Error string', () => {
    const serialized = serializeError('string error');
    expect(serialized.name).toBe('UnknownError');
    expect(serialized.message).toBe('string error');
  });

  test('serializes non-Error object', () => {
    const serialized = serializeError({ code: 42 });
    expect(serialized.name).toBe('UnknownError');
    expect(serialized.message).toContain('42');
  });
});

describe('reconstructError', () => {
  test('reconstructs ThreadExecutionError', () => {
    const serialized = serializeError(new TypeError('bad input'));
    const reconstructed = reconstructError(serialized);
    expect(reconstructed).toBeInstanceOf(ThreadExecutionError);
    expect(reconstructed.originalName).toBe('TypeError');
    expect(reconstructed.message).toBe('bad input');
  });

  test('preserves cause chain', () => {
    const inner = new Error('cause');
    const outer = new Error('effect', { cause: inner });
    const serialized = serializeError(outer);
    const reconstructed = reconstructError(serialized);
    expect(reconstructed.cause).toBeInstanceOf(ThreadExecutionError);
    expect((reconstructed.cause as ThreadExecutionError).message).toBe('cause');
  });
});
