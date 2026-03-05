import { describe, test, expect } from 'bun:test';
import { Channel } from '../src/runtime/channel-factory.js';

describe('Channel Factory', () => {
  test('Channel.in returns ChannelDef with direction in', () => {
    const def = Channel.in();
    expect(def.direction).toBe('in');
  });

  test('Channel.out returns ChannelDef with direction out', () => {
    const def = Channel.out();
    expect(def.direction).toBe('out');
  });

  test('Channel.in passes capacity through', () => {
    const def = Channel.in({ capacity: 1024 });
    expect(def.capacity).toBe(1024);
  });

  test('Channel.out passes capacity through', () => {
    const def = Channel.out({ capacity: 2048 });
    expect(def.capacity).toBe(2048);
  });

  test('Channel.in passes codec through', () => {
    const def = Channel.in<number>({ codec: 'number' });
    expect(def.codec).toBe('number');
  });

  test('Channel.out passes codec through', () => {
    const def = Channel.out<string>({ codec: 'string' });
    expect(def.codec).toBe('string');
  });

  test('Channel.in with no options has undefined capacity and codec', () => {
    const def = Channel.in();
    expect(def.capacity).toBeUndefined();
    expect(def.codec).toBeUndefined();
  });

  test('Channel.out with no options has undefined capacity and codec', () => {
    const def = Channel.out();
    expect(def.capacity).toBeUndefined();
    expect(def.codec).toBeUndefined();
  });
});
