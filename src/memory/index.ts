/**
 * Scatter — Memory primitives (re-exports).
 *
 * Public surface for the `memory` layer. Import from this module to access
 * codecs, atomic signals, ring buffers, and typed shared-memory channels.
 */

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

export type { Codec, BuiltinCodecName, CodecLike } from './codec.js';
export {
  createCodec,
  resolveCodec,
  RAW_CODEC,
  NUMBER_CODEC,
  STRING_CODEC,
  JSON_CODEC,
  STRUCTURED_CODEC,
} from './codec.js';

// ---------------------------------------------------------------------------
// AtomicSignal
// ---------------------------------------------------------------------------

export type { AtomicSignal } from './atomic-signal.js';
export { createAtomicSignal, atomicSignalFromBuffer } from './atomic-signal.js';

// ---------------------------------------------------------------------------
// SharedRingBuffer
// ---------------------------------------------------------------------------

export type { SharedRingBuffer, RingBufferOptions } from './ring-buffer.js';
export { createRingBuffer, ringBufferFromBuffer } from './ring-buffer.js';

// ---------------------------------------------------------------------------
// SharedChannel — interfaces, type utilities, and factory functions
// ---------------------------------------------------------------------------

export type {
  ReadableChannel,
  WritableChannel,
  SharedChannel,
  ChannelTransferables,
  ChannelMeta,
  ChannelDef,
  ChannelDefinitions,
  InferChannelType,
  MainSideChannels,
  WorkerSideChannels,
} from './shared-channel.js';
export { createChannel, channelFromMeta } from './shared-channel.js';
