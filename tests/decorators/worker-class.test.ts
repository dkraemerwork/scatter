import { afterAll, describe, expect, test } from 'bun:test';
import { WorkerClass } from '../../src/decorators/worker-class.js';
import type { WorkerClassStatic, WorkerProxied } from '../../src/decorators/worker-class.js';

@WorkerClass({ pool: 2 })
class WorkerMathService {
  factor = 3;
  callback = () => 123;

  helper(value: number): number {
    return value + 1;
  }

  describe(value: number): { product: number; hasCallback: boolean } {
    return {
      product: this.helper(value) * this.factor,
      hasCallback: typeof this.callback === 'function',
    };
  }

  _localOnly(value: number): number {
    return value * 10;
  }
}

const WorkerMathClass = WorkerMathService as WorkerClassStatic<typeof WorkerMathService>;

afterAll(async () => {
  await WorkerMathClass.disposeWorkers();
});

describe('@WorkerClass', () => {
  test('WC.1: proxies public methods through a shared pool', async () => {
    const service = new WorkerMathService() as WorkerProxied<WorkerMathService> & WorkerMathService;
    const pendingResult = service.describe(13);

    expect(pendingResult).toBeInstanceOf(Promise);
    await expect(pendingResult).resolves.toEqual({
      product: 42,
      hasCallback: false,
    });
  });

  test('WC.2: _prefixed methods stay on the main thread', () => {
    const service = new WorkerMathService();
    expect(service._localOnly(5)).toBe(50);
  });
});
