/**
 * Scatter — Native threads module.
 *
 * Re-exports the public API for native pthread operations via bun:ffi.
 */

export {
  NativeThreads,
  NativeThreadError,
} from './native-threads.js';

export type {
  NativeBurnResult,
  NativeBurnOptions,
  NativeThreadsOptions,
} from './native-threads.js';
