/**
 * Scatter — Channel.in() / Channel.out() factory.
 *
 * Provides the ergonomic `Channel.in<T>()` and `Channel.out<T>()` helpers
 * for declaring direction-typed channel definitions in `scatter.spawn()`.
 *
 * These return plain `ChannelDef<T>` descriptors — no SharedArrayBuffers are
 * allocated here. The actual channels are created at spawn time by the
 * scatter.spawn() runtime.
 */

import type { ChannelDefOptions } from '../scatter.js';
import type { ChannelDef } from '../memory/shared-channel.js';

/**
 * Ergonomic helpers for declaring direction-typed channel definitions.
 *
 * @example
 * ```ts
 * import { Channel } from '@zenystx/scatterjs';
 *
 * const handle = scatter.spawn(workerFn, {
 *   channels: {
 *     tasks:   Channel.in<Task>(),
 *     results: Channel.out<Result>(),
 *   },
 * });
 * ```
 */
export const Channel = {
  /**
   * Define an **inbound** channel: main thread writes, worker reads.
   *
   * @typeParam T  The type of values flowing from main -> worker.
   * @param options  Optional capacity and codec configuration.
   * @returns A `ChannelDef<T>` with `direction: 'in'`.
   */
  in<T>(options?: ChannelDefOptions<T>): ChannelDef<T> & { readonly direction: 'in' } {
    return {
      direction: 'in' as const,
      capacity: options?.capacity,
      codec: options?.codec,
    };
  },

  /**
   * Define an **outbound** channel: worker writes, main thread reads.
   *
   * @typeParam T  The type of values flowing from worker -> main.
   * @param options  Optional capacity and codec configuration.
   * @returns A `ChannelDef<T>` with `direction: 'out'`.
   */
  out<T>(options?: ChannelDefOptions<T>): ChannelDef<T> & { readonly direction: 'out' } {
    return {
      direction: 'out' as const,
      capacity: options?.capacity,
      codec: options?.codec,
    };
  },
};
