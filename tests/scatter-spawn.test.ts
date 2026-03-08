import { describe, test, expect } from 'bun:test';
import { scatter, Channel } from '../src/runtime/index.js';
import { createCodec } from '../src/index.js';

describe('scatter.spawn()', () => {
  test('bidirectional channel communication', async () => {
    const handle = scatter.spawn(
      (ctx: any) => {
        const input = ctx.channel('input');
        const output = ctx.channel('output');

        const fn = async () => {
          const value = await input.readAsync();
          if (value !== null) {
            output.write(value * 2);
          }
          output.close();
        };
        fn();
      },
      {
        channels: {
          input: Channel.in<number>({ codec: 'number' }),
          output: Channel.out<number>({ codec: 'number' }),
        },
      },
    );

    await handle.channels.input.writeBlocking(21, 5000);
    const result = await handle.channels.output.readAsync();
    expect(result).toBe(42);

    handle.terminate();
  });

  test('handle.alive is true before terminate', () => {
    const handle = scatter.spawn(
      (ctx: any) => {
        // Keep alive
        const ch = ctx.channel('ch');
        const fn = async () => {
          await ch.readAsync();
        };
        fn();
      },
      {
        channels: {
          ch: Channel.in<number>({ codec: 'number' }),
        },
      },
    );

    expect(handle.alive).toBe(true);
    handle.terminate();
    expect(handle.alive).toBe(false);
  });

  test('handle has threadId', () => {
    const handle = scatter.spawn(
      (ctx: any) => {
        const ch = ctx.channel('ch');
        const fn = async () => { await ch.readAsync(); };
        fn();
      },
      {
        channels: {
          ch: Channel.in<number>({ codec: 'number' }),
        },
      },
    );

    expect(typeof handle.threadId).toBe('number');
    expect(handle.threadId).toBeGreaterThan(0);
    handle.terminate();
  });

  test('terminate closes all channels', () => {
    const handle = scatter.spawn(
      (ctx: any) => {
        const ch = ctx.channel('ch');
        const fn = async () => { await ch.readAsync(); };
        fn();
      },
      {
        channels: {
          ch: Channel.in<number>({ codec: 'number' }),
        },
      },
    );

    handle.terminate();
    expect(handle.channels.ch.closed).toBe(true);
  });

  test('custom codecs work across the worker boundary', async () => {
    const pairCodec = createCodec<{ left: number; right: number }>({
      name: 'pair',
      encode(value) {
        return new TextEncoder().encode(JSON.stringify(value));
      },
      decode(buffer) {
        return JSON.parse(new TextDecoder().decode(buffer)) as { left: number; right: number };
      },
    });

    const handle = scatter.spawn(
      async (ctx: any) => {
        const input = ctx.channel('input');
        const output = ctx.channel('output');
        const value = await input.readAsync();
        if (value !== null) {
          output.write({ sum: value.left + value.right });
        }
        output.close();
      },
      {
        channels: {
          input: Channel.in<{ left: number; right: number }>({ codec: pairCodec }),
          output: Channel.out<{ sum: number }>({
            codec: createCodec<{ sum: number }>({
              name: 'sum',
              encode(value) {
                return new TextEncoder().encode(JSON.stringify(value));
              },
              decode(buffer) {
                return JSON.parse(new TextDecoder().decode(buffer)) as { sum: number };
              },
            }),
          }),
        },
      },
    );

    handle.channels.input.write({ left: 20, right: 22 });
    handle.channels.input.close();

    expect(await handle.channels.output.readAsync()).toEqual({ sum: 42 });
    handle.terminate();
  });

  test('non-function argument throws TypeError', () => {
    expect(() => {
      (scatter.spawn as any)(42, { channels: {} });
    }).toThrow(TypeError);
  });

  test('missing channels throws TypeError', () => {
    expect(() => {
      (scatter.spawn as any)(() => {}, {});
    }).toThrow(TypeError);
  });
});
