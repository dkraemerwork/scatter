/**
 * Scatter — Wire protocol contract.
 *
 * Defines all message shapes exchanged between the main thread and scatter
 * workers via `postMessage`. This is the internal protocol — users never see
 * these types directly.
 *
 * Message flow overview:
 *
 *   Main → Worker:  INIT → TASK | TASK_BATCH | SHUTDOWN
 *   Worker → Main:  INIT_ACK → RESULT | ERROR | TASK_RESULT | TASK_ERROR
 *                             | HEARTBEAT | SHUTDOWN_ACK
 *
 * All four scaffold modes share the same INIT/INIT_ACK handshake. The `mode`
 * field on INIT lets the worker select the correct boot behavior.
 */

import type { SerializedError } from './error.js';
import type { ChannelMeta } from './memory/shared-channel.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * All `__type` discriminant string literals in one place.
 * Use these values instead of raw string literals to avoid typos.
 *
 * @example
 * ```ts
 * if (msg.__type === ScatterMessageType.INIT_ACK) { ... }
 * ```
 */
export const ScatterMessageType = {
  /** Main → Worker: initialise the worker after creation. */
  INIT: '__SCATTER_INIT__',
  /** Main → Worker: dispatch a single task (pool / max). */
  TASK: '__SCATTER_TASK__',
  /** Main → Worker: dispatch multiple tasks in one call (pool / max). */
  TASK_BATCH: '__SCATTER_TASK_BATCH__',
  /** Main → Worker: request graceful shutdown. */
  SHUTDOWN: '__SCATTER_SHUTDOWN__',
  /** Worker → Main: hydration complete, ready to accept work. */
  INIT_ACK: '__SCATTER_INIT_ACK__',
  /** Worker → Main: oneshot / spawn worker completed successfully. */
  RESULT: '__SCATTER_RESULT__',
  /** Worker → Main: oneshot / spawn worker threw an error. */
  ERROR: '__SCATTER_ERROR__',
  /** Worker → Main: pool / max worker completed a task. */
  TASK_RESULT: '__SCATTER_TASK_RESULT__',
  /** Worker → Main: pool / max worker failed a task. */
  TASK_ERROR: '__SCATTER_TASK_ERROR__',
  /** Worker → Main: periodic liveness signal for long-lived workers. */
  HEARTBEAT: '__SCATTER_HEARTBEAT__',
  /** Worker → Main: graceful shutdown complete. */
  SHUTDOWN_ACK: '__SCATTER_SHUTDOWN_ACK__',
} as const;

/**
 * Union of all `ScatterMessageType` values — mirrors the `__type`
 * discriminant field across every message interface.
 */
export type ScatterMessageTypeValue =
  (typeof ScatterMessageType)[keyof typeof ScatterMessageType];

/**
 * The four scaffold modes supported by scatter.
 *
 * - `oneshot` — worker runs once and exits.
 * - `spawn`   — persistent single worker, called repeatedly.
 * - `pool`    — fixed pool of reusable workers.
 * - `max`     — auto-scaling pool up to `navigator.hardwareConcurrency`.
 */
export type ScaffoldMode = 'oneshot' | 'spawn' | 'pool' | 'max';

// ---------------------------------------------------------------------------
// Main → Worker messages
// ---------------------------------------------------------------------------

/**
 * Sent by the main thread once, immediately after worker creation.
 *
 * Direction: **Main → Worker**
 *
 * The worker must reply with {@link ScatterInitAckMessage} after it has
 * hydrated all shared-memory channels. The main thread must not write to any
 * channel before receiving the ack.
 */
export interface ScatterInitMessage {
  /** Discriminant. */
  readonly __type: typeof ScatterMessageType.INIT;
  /**
   * Opaque numeric identifier for this worker thread. Echoed back in
   * {@link ScatterInitAckMessage} as confirmation.
   */
  readonly threadId: number;
  /**
   * The scaffold mode the worker was created under. The worker uses this to
   * select the appropriate boot path (oneshot loop, spawn loop, pool loop, or
   * max loop).
   */
  readonly mode: ScaffoldMode;
  /**
   * Arbitrary user-supplied initialisation data forwarded to the worker's
   * `init` hook.
   */
  readonly data: Record<string, unknown>;
  /**
   * Descriptors for every named shared-memory channel. The worker must
   * hydrate each channel from this metadata before posting INIT_ACK.
   */
  readonly channelMeta: Record<string, ChannelMeta>;
}

/**
 * Dispatches a single task to a pool or max worker.
 *
 * Direction: **Main → Worker**
 *
 * Must only be sent after {@link ScatterInitAckMessage} has been received.
 * The worker replies with {@link ScatterTaskResultMessage} or
 * {@link ScatterTaskErrorMessage}.
 */
export interface ScatterTaskMessage {
  /** Discriminant. */
  readonly __type: typeof ScatterMessageType.TASK;
  /**
   * Unique task identifier. The worker echoes this back in its result/error
   * message so the main thread can correlate responses.
   */
  readonly taskId: number;
  /** Serialisable task input forwarded to the worker function. */
  readonly input: unknown;
}

/**
 * A single item within a {@link ScatterTaskBatchMessage}.
 */
export interface ScatterTaskBatchItem {
  /** Unique task identifier — same semantics as in {@link ScatterTaskMessage}. */
  readonly taskId: number;
  /** Serialisable task input for this task. */
  readonly input: unknown;
}

/**
 * Dispatches multiple tasks to a pool or max worker in a single `postMessage`
 * call, reducing inter-thread round-trips for high-throughput workloads.
 *
 * Direction: **Main → Worker**
 *
 * Must only be sent after {@link ScatterInitAckMessage} has been received.
 * The worker posts one {@link ScatterTaskResultMessage} or
 * {@link ScatterTaskErrorMessage} per task in the batch.
 */
export interface ScatterTaskBatchMessage {
  /** Discriminant. */
  readonly __type: typeof ScatterMessageType.TASK_BATCH;
  /** Non-empty array of tasks to execute. */
  readonly tasks: readonly ScatterTaskBatchItem[];
}

/**
 * Requests graceful shutdown of the worker.
 *
 * Direction: **Main → Worker**
 *
 * The worker must finish any in-flight tasks, release resources, and then
 * post {@link ScatterShutdownAckMessage}. The main thread must call
 * `worker.terminate()` only after receiving the ack, not before.
 */
export interface ScatterShutdownMessage {
  /** Discriminant. */
  readonly __type: typeof ScatterMessageType.SHUTDOWN;
}

// ---------------------------------------------------------------------------
// Worker → Main messages
// ---------------------------------------------------------------------------

/**
 * Posted by the worker after it has successfully hydrated all shared-memory
 * channels described in {@link ScatterInitMessage}.
 *
 * Direction: **Worker → Main**
 *
 * Sent by workers in **all** scaffold modes (oneshot, spawn, pool, max).
 * The main thread must wait for this message before writing to any shared
 * channel or dispatching tasks.
 */
export interface ScatterInitAckMessage {
  /** Discriminant. */
  readonly __type: typeof ScatterMessageType.INIT_ACK;
  /**
   * Echo of the `threadId` received in {@link ScatterInitMessage}.
   * Allows the main thread to confirm the correct worker acknowledged.
   */
  readonly threadId: number;
}

/**
 * Posted by a oneshot or spawn worker when the worker function returns a
 * value successfully.
 *
 * Direction: **Worker → Main**
 */
export interface ScatterResultMessage {
  /** Discriminant. */
  readonly __type: typeof ScatterMessageType.RESULT;
  /** The serialisable return value of the worker function. */
  readonly value: unknown;
}

/**
 * Posted by a oneshot or spawn worker when the worker function throws an
 * error.
 *
 * Direction: **Worker → Main**
 */
export interface ScatterErrorMessage {
  /** Discriminant. */
  readonly __type: typeof ScatterMessageType.ERROR;
  /** Serialised representation of the thrown error. */
  readonly error: SerializedError;
}

/**
 * Posted by a pool or max worker when a task completes successfully.
 *
 * Direction: **Worker → Main**
 */
export interface ScatterTaskResultMessage {
  /** Discriminant. */
  readonly __type: typeof ScatterMessageType.TASK_RESULT;
  /**
   * The `taskId` from the originating {@link ScatterTaskMessage} or
   * {@link ScatterTaskBatchItem}, used by the main thread to resolve the
   * correct promise.
   */
  readonly taskId: number;
  /** The serialisable return value of the task function. */
  readonly value: unknown;
}

/**
 * Posted by a pool or max worker when a task throws an error.
 *
 * Direction: **Worker → Main**
 */
export interface ScatterTaskErrorMessage {
  /** Discriminant. */
  readonly __type: typeof ScatterMessageType.TASK_ERROR;
  /**
   * The `taskId` from the originating {@link ScatterTaskMessage} or
   * {@link ScatterTaskBatchItem}.
   */
  readonly taskId: number;
  /** Serialised representation of the thrown error. */
  readonly error: SerializedError;
}

/**
 * Periodic liveness signal from long-lived workers (spawn / pool / max).
 *
 * Direction: **Worker → Main**
 *
 * The main thread can use the `timestamp` to detect stalled workers (e.g.
 * workers that have not sent a heartbeat within a configurable deadline) and
 * take corrective action such as forced termination and replacement.
 */
export interface ScatterHeartbeatMessage {
  /** Discriminant. */
  readonly __type: typeof ScatterMessageType.HEARTBEAT;
  /**
   * `Date.now()` value captured inside the worker at the moment the heartbeat
   * is emitted. Allows the main thread to measure actual worker latency rather
   * than just message delivery latency.
   */
  readonly timestamp: number;
}

/**
 * Confirms that the worker has finished cleaning up after a
 * {@link ScatterShutdownMessage}.
 *
 * Direction: **Worker → Main**
 *
 * The main thread must receive this message before calling
 * `worker.terminate()` to guarantee that no SharedArrayBuffer writes are in
 * flight at termination time.
 */
export interface ScatterShutdownAckMessage {
  /** Discriminant. */
  readonly __type: typeof ScatterMessageType.SHUTDOWN_ACK;
}

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

/** All messages that can be sent from the main thread to a worker. */
export type MainToWorkerMessage =
  | ScatterInitMessage
  | ScatterTaskMessage
  | ScatterTaskBatchMessage
  | ScatterShutdownMessage;

/** All messages that can be sent from a worker to the main thread. */
export type WorkerToMainMessage =
  | ScatterInitAckMessage
  | ScatterResultMessage
  | ScatterErrorMessage
  | ScatterTaskResultMessage
  | ScatterTaskErrorMessage
  | ScatterHeartbeatMessage
  | ScatterShutdownAckMessage;

/** Any scatter protocol message, regardless of direction. */
export type ScatterMessage = MainToWorkerMessage | WorkerToMainMessage;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Narrows `msg` to {@link ScatterInitMessage}.
 *
 * @example
 * ```ts
 * worker.onmessage = ({ data }) => {
 *   if (isInit(data)) { // data is ScatterInitMessage
 *     hydrate(data.channelMeta);
 *   }
 * };
 * ```
 */
export function isInit(msg: ScatterMessage): msg is ScatterInitMessage {
  return msg.__type === ScatterMessageType.INIT;
}

/**
 * Narrows `msg` to {@link ScatterInitAckMessage}.
 *
 * Useful on the main thread when waiting for all workers to finish hydration
 * before dispatching tasks.
 */
export function isInitAck(msg: ScatterMessage): msg is ScatterInitAckMessage {
  return msg.__type === ScatterMessageType.INIT_ACK;
}

/**
 * Narrows `msg` to {@link ScatterTaskMessage}.
 */
export function isTask(msg: ScatterMessage): msg is ScatterTaskMessage {
  return msg.__type === ScatterMessageType.TASK;
}

/**
 * Narrows `msg` to {@link ScatterTaskBatchMessage}.
 */
export function isTaskBatch(
  msg: ScatterMessage,
): msg is ScatterTaskBatchMessage {
  return msg.__type === ScatterMessageType.TASK_BATCH;
}

/**
 * Narrows `msg` to {@link ScatterShutdownMessage}.
 */
export function isShutdown(msg: ScatterMessage): msg is ScatterShutdownMessage {
  return msg.__type === ScatterMessageType.SHUTDOWN;
}

/**
 * Narrows `msg` to {@link ScatterResultMessage}.
 */
export function isResult(msg: ScatterMessage): msg is ScatterResultMessage {
  return msg.__type === ScatterMessageType.RESULT;
}

/**
 * Narrows `msg` to {@link ScatterErrorMessage}.
 */
export function isError(msg: ScatterMessage): msg is ScatterErrorMessage {
  return msg.__type === ScatterMessageType.ERROR;
}

/**
 * Narrows `msg` to {@link ScatterTaskResultMessage}.
 */
export function isTaskResult(
  msg: ScatterMessage,
): msg is ScatterTaskResultMessage {
  return msg.__type === ScatterMessageType.TASK_RESULT;
}

/**
 * Narrows `msg` to {@link ScatterTaskErrorMessage}.
 */
export function isTaskError(
  msg: ScatterMessage,
): msg is ScatterTaskErrorMessage {
  return msg.__type === ScatterMessageType.TASK_ERROR;
}

/**
 * Narrows `msg` to {@link ScatterHeartbeatMessage}.
 */
export function isHeartbeat(
  msg: ScatterMessage,
): msg is ScatterHeartbeatMessage {
  return msg.__type === ScatterMessageType.HEARTBEAT;
}

/**
 * Narrows `msg` to {@link ScatterShutdownAckMessage}.
 */
export function isShutdownAck(
  msg: ScatterMessage,
): msg is ScatterShutdownAckMessage {
  return msg.__type === ScatterMessageType.SHUTDOWN_ACK;
}
