import { describe, test, expect } from 'bun:test';
import {
  ScatterMessageType,
  isInit,
  isInitAck,
  isTask,
  isTaskBatch,
  isShutdown,
  isResult,
  isError,
  isTaskResult,
  isTaskError,
  isHeartbeat,
  isShutdownAck,
} from '../src/protocol.js';

describe('ScatterMessageType', () => {
  test('all values are unique strings', () => {
    const values = Object.values(ScatterMessageType);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    for (const v of values) {
      expect(typeof v).toBe('string');
    }
  });

  test('values start with __SCATTER_', () => {
    for (const v of Object.values(ScatterMessageType)) {
      expect(v).toMatch(/^__SCATTER_/);
    }
  });
});

describe('Type Guards', () => {
  test('isInit', () => {
    expect(isInit({ __type: ScatterMessageType.INIT, threadId: 1, mode: 'oneshot', data: {}, channelMeta: {} } as any)).toBe(true);
    expect(isInit({ __type: ScatterMessageType.RESULT, value: 42 } as any)).toBe(false);
  });

  test('isInitAck', () => {
    expect(isInitAck({ __type: ScatterMessageType.INIT_ACK, threadId: 1 } as any)).toBe(true);
    expect(isInitAck({ __type: ScatterMessageType.INIT, threadId: 1, mode: 'oneshot', data: {}, channelMeta: {} } as any)).toBe(false);
  });

  test('isTask', () => {
    expect(isTask({ __type: ScatterMessageType.TASK, taskId: 1, input: 42 } as any)).toBe(true);
  });

  test('isTaskBatch', () => {
    expect(isTaskBatch({ __type: ScatterMessageType.TASK_BATCH, tasks: [] } as any)).toBe(true);
  });

  test('isShutdown', () => {
    expect(isShutdown({ __type: ScatterMessageType.SHUTDOWN } as any)).toBe(true);
  });

  test('isResult', () => {
    expect(isResult({ __type: ScatterMessageType.RESULT, value: 42 } as any)).toBe(true);
  });

  test('isError', () => {
    expect(isError({ __type: ScatterMessageType.ERROR, error: { name: 'Error', message: '', stack: '' } } as any)).toBe(true);
  });

  test('isTaskResult', () => {
    expect(isTaskResult({ __type: ScatterMessageType.TASK_RESULT, taskId: 1, value: 42 } as any)).toBe(true);
  });

  test('isTaskError', () => {
    expect(isTaskError({ __type: ScatterMessageType.TASK_ERROR, taskId: 1, error: { name: 'Error', message: '', stack: '' } } as any)).toBe(true);
  });

  test('isHeartbeat', () => {
    expect(isHeartbeat({ __type: ScatterMessageType.HEARTBEAT, timestamp: Date.now() } as any)).toBe(true);
  });

  test('isShutdownAck', () => {
    expect(isShutdownAck({ __type: ScatterMessageType.SHUTDOWN_ACK } as any)).toBe(true);
  });
});
