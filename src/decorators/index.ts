export { Scaled } from './scaled.js';
export type { ScaledMethod, ScaledOptions } from './scaled.js';

export { WorkerClass } from './worker-class.js';
export type {
  WorkerClassOptions,
  WorkerClassStatic,
  WorkerProxied,
} from './worker-class.js';

import { allDecoratorPools } from './scaled.js';

export async function cleanupAllDecoratorPools(): Promise<void> {
  const pools = [...allDecoratorPools];
  const errors: Error[] = [];

  await Promise.allSettled(
    pools.map(async (pool) => {
      try {
        await pool.shutdown();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      } finally {
        allDecoratorPools.delete(pool);
      }
    }),
  );

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `[scatter] ${errors.length} decorator pool(s) failed to shut down cleanly`,
    );
  }
}
