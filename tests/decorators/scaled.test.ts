import { describe, expect, test } from 'bun:test';
import { Scaled } from '../../src/decorators/scaled.js';

describe('@Scaled', () => {
  test('SC.1: offloads method calls with serialized instance state', async () => {
    class MultiplierService {
      multiplier = 7;
      callback = () => 123;

      // @ts-expect-error Stage 3 decorators cannot model the Promise-wrapped return type.
      @Scaled()
      inspect(value: number): { product: number; hasCallback: boolean } {
        return {
          product: value * this.multiplier,
          hasCallback: typeof this.callback === 'function',
        };
      }
    }

    const service = new MultiplierService();
    const pendingResult = service.inspect(6);

    expect(pendingResult).toBeInstanceOf(Promise);
    await expect(pendingResult).resolves.toEqual({
      product: 42,
      hasCallback: false,
    });
  });
});
