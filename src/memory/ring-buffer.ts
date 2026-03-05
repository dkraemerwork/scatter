/**
 * Scatter — SharedRingBuffer implementation.
 *
 * Wait-free, single-producer / single-consumer (SPSC) ring buffer for
 * variable-size, length-prefixed messages over a SharedArrayBuffer.
 *
 * Memory layout (single SharedArrayBuffer):
 *
 *   Offset  Size  Field
 *   ------  ----  -----
 *   0       4     Write cursor  (Uint32, monotonically increasing, atomic)
 *   4       4     Read cursor   (Uint32, monotonically increasing, atomic)
 *   8       4     Closed flag   (Uint32, 0 = open, 1 = closed, atomic)
 *   12      N     Data region   (Uint8Array, circular)
 *
 * Wire format per message:
 *   [4 bytes: payload length (Uint32 BE)] [N bytes: payload]
 *
 * Physical offset = cursor % capacity (mod wraps around the data ring).
 * Messages that straddle the wrap boundary are split across it.
 *
 * Cursor semantics:
 *   - Cursors are monotonically increasing 32-bit integers (they overflow
 *     safely at 2^32, since physical offset is always computed mod capacity).
 *   - The producer owns the write cursor; the consumer owns the read cursor.
 *   - Each side reads the other side's cursor with `Atomics.load` and writes
 *     its own with `Atomics.store`. No CAS needed for SPSC.
 *
 * Factory functions:
 *   - {@link createRingBuffer}        — allocates a fresh SAB.
 *   - {@link ringBufferFromBuffer}    — wraps an existing SAB (worker side).
 */

// ---------------------------------------------------------------------------
// Header layout constants
// ---------------------------------------------------------------------------

/** Byte offset of the write cursor in the header (Uint32). */
const WRITE_CURSOR_OFFSET = 0;

/** Byte offset of the read cursor in the header (Uint32). */
const READ_CURSOR_OFFSET = 1;

/** Byte offset of the closed flag in the header (Uint32). */
const CLOSED_FLAG_OFFSET = 2;

/** Number of Uint32 cells in the header (3 × 4 = 12 bytes). */
const HEADER_CELLS = 3;

/** Byte size of the header region. */
const HEADER_BYTES = HEADER_CELLS * 4;

/** Default data-region capacity in bytes (64 KiB). */
const DEFAULT_CAPACITY = 65536;

/** Byte size of the per-message length prefix (Uint32 BE). */
const LENGTH_PREFIX_BYTES = 4;

/** Closed flag value. */
const FLAG_CLOSED = 1;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Wait-free SPSC ring buffer for variable-length byte messages over a
 * `SharedArrayBuffer`.
 *
 * **Thread safety:** The producer thread owns all `push*` methods; the
 * consumer thread owns all `pop*` methods. Do NOT call both from the same
 * thread without external coordination.
 *
 * Implements {@link Disposable} so it can be used with `using`:
 * ```ts
 * using rb = createRingBuffer({ capacity: 4096 });
 * ```
 */
export interface SharedRingBuffer {
  /**
   * Write a single message to the ring.
   *
   * Non-blocking "try" operation. Returns `true` if written, `false` if
   * there is insufficient space (the consumer hasn't caught up).
   *
   * The producer is responsible for retrying or applying backpressure when
   * this returns `false`.
   *
   * Only the **producer** thread should call this.
   *
   * @example
   * ```ts
   * const ok = rb.push(encode(myValue));
   * if (!ok) console.warn('ring full — backpressure');
   * ```
   */
  push(data: Uint8Array): boolean;

  /**
   * Write multiple messages in a single logical pass.
   *
   * Messages are written until one would overflow the available space, at
   * which point writing stops. Returns the number of messages successfully
   * written (may be less than `messages.length`).
   *
   * Only the **producer** thread should call this.
   *
   * @example
   * ```ts
   * const written = rb.pushBatch([msg1, msg2, msg3]);
   * if (written < 3) console.warn(`Only ${written}/3 messages fit`);
   * ```
   */
  pushBatch(messages: readonly Uint8Array[]): number;

  /**
   * Read the next message from the ring.
   *
   * Non-blocking. Returns `null` if no messages are pending or after close
   * once all buffered messages have been drained.
   *
   * Only the **consumer** thread should call this.
   *
   * @example
   * ```ts
   * const msg = rb.pop();
   * if (msg !== null) process(msg);
   * ```
   */
  pop(): Uint8Array | null;

  /**
   * Read up to `maxCount` messages in a single call.
   *
   * Non-blocking. Reads the write cursor once and drains up to `maxCount`
   * messages from what is available, amortizing per-message Atomics overhead.
   * Returns an empty array if no messages are pending.
   *
   * Only the **consumer** thread should call this.
   *
   * @example
   * ```ts
   * const batch = rb.popBatch(64);
   * for (const msg of batch) process(msg);
   * ```
   */
  popBatch(maxCount: number): Uint8Array[];

  /** Number of bytes available for writing (approximate — racy but safe for backpressure). */
  available(): number;

  /** Number of bytes pending for reading (approximate — racy but safe). */
  pending(): number;

  /**
   * Mark the ring as closed. No further pushes will succeed after this call.
   * The consumer can still drain all messages that were written before close.
   */
  close(): void;

  /** `true` if the ring has been closed. */
  readonly closed: boolean;

  /** `true` if no messages are currently pending for reading. */
  readonly isEmpty: boolean;

  /** Total capacity of the data region in bytes (excludes the 12-byte header). */
  readonly capacity: number;

  /** The underlying SharedArrayBuffer (pass to a worker via `postMessage`). */
  readonly buffer: SharedArrayBuffer;

  /**
   * Dispose implementation — calls {@link close}.
   * Enables `using rb = createRingBuffer()`.
   */
  [Symbol.dispose](): void;
}

/** Options for {@link createRingBuffer}. */
export interface RingBufferOptions {
  /**
   * Capacity of the data region in bytes.
   * Does NOT include the 12-byte header. Default: 65536 (64 KiB).
   */
  readonly capacity?: number;
}

// ---------------------------------------------------------------------------
// Wrap helpers — split reads/writes across the circular boundary
// ---------------------------------------------------------------------------

/**
 * Write `src` into `dst` starting at physical byte `offset`, wrapping around
 * at `capacity`. Handles splits transparently.
 * @internal
 */
function wrappedWrite(dst: Uint8Array, src: Uint8Array, offset: number, capacity: number): void {
  const end = offset + src.length;
  if (end <= capacity) {
    // Contiguous write.
    dst.set(src, offset);
  } else {
    // Split across the wrap boundary.
    const firstLen = capacity - offset;
    dst.set(src.subarray(0, firstLen), offset);
    dst.set(src.subarray(firstLen), 0);
  }
}

/**
 * Read `length` bytes from `src` starting at physical byte `offset`, wrapping
 * around at `capacity`. Returns a new `Uint8Array` with the data.
 * @internal
 */
function wrappedRead(src: Uint8Array, offset: number, length: number, capacity: number): Uint8Array {
  const end = offset + length;
  if (end <= capacity) {
    // Contiguous read — copy to own buffer so the caller owns the data.
    return src.slice(offset, end);
  }
  // Split across the wrap boundary.
  const result = new Uint8Array(length);
  const firstLen = capacity - offset;
  result.set(src.subarray(offset, offset + firstLen), 0);
  result.set(src.subarray(0, length - firstLen), firstLen);
  return result;
}

// ---------------------------------------------------------------------------
// Length prefix helpers (big-endian Uint32)
// ---------------------------------------------------------------------------

/** Write a 4-byte big-endian Uint32 into `scratch`. @internal */
function encodeLengthPrefix(value: number, scratch: Uint8Array): void {
  scratch[0] = (value >>> 24) & 0xff;
  scratch[1] = (value >>> 16) & 0xff;
  scratch[2] = (value >>> 8) & 0xff;
  scratch[3] = value & 0xff;
}

/** Decode a 4-byte big-endian Uint32. @internal */
function decodeLengthPrefix(bytes: Uint8Array): number {
  return (
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  );
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

function makeRingBuffer(sab: SharedArrayBuffer, capacity: number): SharedRingBuffer {
  // Uint32Array view over the 12-byte header.
  const header = new Uint32Array(sab, 0, HEADER_CELLS);
  // Uint8Array view over the data region only.
  const data = new Uint8Array(sab, HEADER_BYTES, capacity);


  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Read the current write cursor (used by consumer via Atomics). */
  function loadWriteCursor(): number {
    return Atomics.load(header, WRITE_CURSOR_OFFSET);
  }

  /** Read the current read cursor (used by producer via Atomics). */
  function loadReadCursor(): number {
    return Atomics.load(header, READ_CURSOR_OFFSET);
  }

  /**
   * Attempt to write a single pre-validated message (header + payload) at the
   * given write cursor position. Returns the new write cursor value.
   * @internal
   */
  function writeMessage(writeCursor: number, payload: Uint8Array): number {
    const lenScratch = new Uint8Array(4);
    const payloadLen = payload.length;
    const totalBytes = LENGTH_PREFIX_BYTES + payloadLen;
    const physWrite = writeCursor % capacity;

    encodeLengthPrefix(payloadLen, lenScratch);
    wrappedWrite(data, lenScratch, physWrite, capacity);
    wrappedWrite(data, payload, (physWrite + LENGTH_PREFIX_BYTES) % capacity, capacity);

    // Return cursor advanced by the full frame size (wraps at 2^32 naturally).
    return (writeCursor + totalBytes) >>> 0;
  }

  /**
   * Read a single message starting at the given read cursor, if one is
   * available within `availableBytes`. Returns `[payload, newReadCursor]` or
   * `null` if no complete message is present.
   * @internal
   */
  function readMessage(
    readCursor: number,
    availableBytes: number,
  ): [Uint8Array, number] | null {
    if (availableBytes < LENGTH_PREFIX_BYTES) return null;

    const physRead = readCursor % capacity;
    const lenBytes = wrappedRead(data, physRead, LENGTH_PREFIX_BYTES, capacity);
    const payloadLen = decodeLengthPrefix(lenBytes);
    const totalBytes = LENGTH_PREFIX_BYTES + payloadLen;

    if (availableBytes < totalBytes) return null;

    const payload = wrappedRead(
      data,
      (physRead + LENGTH_PREFIX_BYTES) % capacity,
      payloadLen,
      capacity,
    );
    const newReadCursor = (readCursor + totalBytes) >>> 0;
    return [payload, newReadCursor];
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  return {
    get buffer() {
      return sab;
    },

    get capacity() {
      return capacity;
    },

    get closed(): boolean {
      return Atomics.load(header, CLOSED_FLAG_OFFSET) === FLAG_CLOSED;
    },

    get isEmpty(): boolean {
      const writeCursor = loadWriteCursor();
      const readCursor = loadReadCursor();
      return writeCursor === readCursor;
    },

    available(): number {
      const writeCursor = Atomics.load(header, WRITE_CURSOR_OFFSET);
      const readCursor = Atomics.load(header, READ_CURSOR_OFFSET);
      // pending bytes = writeCursor - readCursor (unsigned 32-bit arithmetic).
      const pending = (writeCursor - readCursor) >>> 0;
      return capacity - pending;
    },

    pending(): number {
      const writeCursor = Atomics.load(header, WRITE_CURSOR_OFFSET);
      const readCursor = Atomics.load(header, READ_CURSOR_OFFSET);
      return (writeCursor - readCursor) >>> 0;
    },

    push(payload: Uint8Array): boolean {
      if (Atomics.load(header, CLOSED_FLAG_OFFSET) === FLAG_CLOSED) return false;

      const frameSize = LENGTH_PREFIX_BYTES + payload.length;
      if (frameSize > capacity) return false;

      const readCursor = loadReadCursor();
      const writeCursor = Atomics.load(header, WRITE_CURSOR_OFFSET);
      const availableBytes = capacity - ((writeCursor - readCursor) >>> 0);

      if (frameSize > availableBytes) return false;

      const newWriteCursor = writeMessage(writeCursor, payload);
      Atomics.store(header, WRITE_CURSOR_OFFSET, newWriteCursor);
      return true;
    },

    pushBatch(messages: readonly Uint8Array[]): number {
      if (Atomics.load(header, CLOSED_FLAG_OFFSET) === FLAG_CLOSED) return 0;

      const readCursor = loadReadCursor();
      let writeCursor = Atomics.load(header, WRITE_CURSOR_OFFSET);
      let written = 0;

      for (const payload of messages) {
        const frameSize = LENGTH_PREFIX_BYTES + payload.length;
        if (frameSize > capacity) break;

        const availableBytes = capacity - ((writeCursor - readCursor) >>> 0);

        if (frameSize > availableBytes) break;

        writeCursor = writeMessage(writeCursor, payload);
        written++;
      }

      if (written > 0) {
        Atomics.store(header, WRITE_CURSOR_OFFSET, writeCursor);
      }

      return written;
    },

    pop(): Uint8Array | null {
      let readCursor = Atomics.load(header, READ_CURSOR_OFFSET);
      const writeCursor = loadWriteCursor();
      const availableBytes = (writeCursor - readCursor) >>> 0;

      const result = readMessage(readCursor, availableBytes);
      if (result === null) return null;

      const [payload, newReadCursor] = result;
      Atomics.store(header, READ_CURSOR_OFFSET, newReadCursor);
      return payload;
    },

    popBatch(maxCount: number): Uint8Array[] {
      const batch: Uint8Array[] = [];
      if (maxCount <= 0) return batch;

      let readCursor = Atomics.load(header, READ_CURSOR_OFFSET);
      // Snapshot the write cursor once to amortize Atomics overhead.
      const writeCursor = loadWriteCursor();
      let remainingBytes = (writeCursor - readCursor) >>> 0;

      while (batch.length < maxCount && remainingBytes >= LENGTH_PREFIX_BYTES) {
        const result = readMessage(readCursor, remainingBytes);
        if (result === null) break;

        const [payload, newReadCursor] = result;
        batch.push(payload);
        remainingBytes -= (newReadCursor - readCursor) >>> 0;
        readCursor = newReadCursor;
      }

      if (batch.length > 0) {
        Atomics.store(header, READ_CURSOR_OFFSET, readCursor);
      }

      return batch;
    },

    close(): void {
      Atomics.store(header, CLOSED_FLAG_OFFSET, FLAG_CLOSED);
    },

    [Symbol.dispose](): void {
      this.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory functions
// ---------------------------------------------------------------------------

/**
 * Create a new {@link SharedRingBuffer} backed by a fresh
 * `SharedArrayBuffer`. This is the **producer** side.
 *
 * Pass `rb.buffer` to the worker, then reconstruct there with
 * {@link ringBufferFromBuffer}.
 *
 * @param options Optional capacity override.
 *
 * @example
 * ```ts
 * const rb = createRingBuffer({ capacity: 1024 * 1024 }); // 1 MiB
 * worker.postMessage({ ringBuffer: rb.buffer });
 * rb.push(encode(myMessage));
 * ```
 */
export function createRingBuffer(options?: RingBufferOptions): SharedRingBuffer {
  const capacity = options?.capacity ?? DEFAULT_CAPACITY;
  if (capacity <= 0 || !Number.isInteger(capacity)) {
    throw new RangeError(
      `scatter: createRingBuffer capacity must be a positive integer, got ${capacity}.`,
    );
  }
  const sab = new SharedArrayBuffer(HEADER_BYTES + capacity);
  return makeRingBuffer(sab, capacity);
}

/**
 * Wrap an existing `SharedArrayBuffer` as a {@link SharedRingBuffer}.
 *
 * Use this on the **consumer / worker** side after receiving the buffer via
 * `postMessage`. Both producer and consumer views share the same memory.
 *
 * @param buffer A `SharedArrayBuffer` previously created by
 *   {@link createRingBuffer}.
 *
 * @example
 * ```ts
 * // Inside a Bun worker:
 * self.onmessage = ({ data }) => {
 *   const rb = ringBufferFromBuffer(data.ringBuffer);
 *   const msg = rb.pop();
 *   if (msg) handle(msg);
 * };
 * ```
 *
 * @throws {RangeError} If the buffer is too small to contain the header.
 */
export function ringBufferFromBuffer(buffer: SharedArrayBuffer): SharedRingBuffer {
  if (buffer.byteLength <= HEADER_BYTES) {
    throw new RangeError(
      `scatter: ringBufferFromBuffer requires a SharedArrayBuffer larger than ` +
      `${HEADER_BYTES} bytes (the header), got ${buffer.byteLength} bytes.`,
    );
  }
  const capacity = buffer.byteLength - HEADER_BYTES;
  return makeRingBuffer(buffer, capacity);
}
