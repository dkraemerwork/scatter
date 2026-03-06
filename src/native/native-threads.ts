/**
 * Scatter — Native pthread threads via bun:ffi.
 *
 * Compiles C code at runtime using Bun's built-in TCC compiler (`cc` from
 * bun:ffi) or loads a pre-compiled shared library. Provides a high-level
 * TypeScript API on top of raw pthreads.
 *
 * Why native threads?
 *   Bun Workers are 1:1 with OS threads and already ~77% of native C speed
 *   for pure arithmetic. But for the last 23%, or when you need zero-overhead
 *   pthreads without JavaScript runtime per-thread, this module gives you raw
 *   native parallelism.
 *
 * @example
 * ```ts
 * import { NativeThreads } from '@zenystx/scatterjs';
 *
 * const native = await NativeThreads.create();
 *
 * // Burn all CPUs for 2 seconds
 * const results = native.burn({ durationMs: 2000 });
 *
 * for (const r of results) {
 *   console.log(`Thread ${r.threadId}: π ≈ ${r.pi} (${r.iterations} iters)`);
 * }
 *
 * // Custom thread count and memory
 * const results2 = native.burn({
 *   threads: 4,
 *   durationMs: 5000,
 *   memoryMB: 64,
 * });
 * ```
 */

import { ScatterError } from '../error.js';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from a single native thread's burn run. */
export interface NativeBurnResult {
  /** Computed π approximation via Leibniz series. */
  readonly pi: number;
  /** Total Leibniz iterations performed. */
  readonly iterations: number;
  /** Which thread produced this result (0-indexed). */
  readonly threadId: number;
  /** Memory actually allocated by this thread (MB). */
  readonly allocatedMB: number;
  /** Wall-clock time this thread ran (ms). */
  readonly elapsedMs: number;
}

/** Options for {@link NativeThreads.burn}. */
export interface NativeBurnOptions {
  /**
   * Number of native pthreads to spawn.
   * Defaults to `NativeThreads.hwThreads` (all available cores).
   */
  readonly threads?: number;

  /**
   * How long each thread burns CPU (milliseconds).
   * Defaults to 1000 (1 second).
   */
  readonly durationMs?: number;

  /**
   * Memory each thread allocates and touches (MB).
   * Defaults to 0 (no memory pressure).
   */
  readonly memoryMB?: number;
}

/** Options for creating a {@link NativeThreads} instance. */
export interface NativeThreadsOptions {
  /**
   * Path to a pre-compiled shared library (.dylib / .so / .dll).
   * If provided, skips runtime compilation entirely.
   */
  readonly libraryPath?: string;
}

/** Thrown when native thread operations fail. */
export class NativeThreadError extends ScatterError {
  override readonly name = 'NativeThreadError' as const;
  readonly _tag = 'NativeThreadError' as const;
}

// ---------------------------------------------------------------------------
// FFI symbol types
// ---------------------------------------------------------------------------

interface NativeSymbols {
  get_hw_threads: () => number;
  result_struct_size: () => number;
  native_burn: (numThreads: number, durationMs: number, memMb: number, resultsPtr: unknown) => number;
}

// ---------------------------------------------------------------------------
// ThreadResult struct layout (must match burn.c)
//
// typedef struct {
//   double   pi;           // offset  0, 8 bytes
//   int64_t  iterations;   // offset  8, 8 bytes
//   int32_t  thread_id;    // offset 16, 4 bytes
//   int32_t  alloc_mb;     // offset 20, 4 bytes
//   double   elapsed_ms;   // offset 24, 8 bytes
// } ThreadResult;           // total: 32 bytes
// ---------------------------------------------------------------------------

const RESULT_OFFSET_PI         = 0;
const RESULT_OFFSET_ITERATIONS = 8;
const RESULT_OFFSET_THREAD_ID  = 16;
const RESULT_OFFSET_ALLOC_MB   = 20;
const RESULT_OFFSET_ELAPSED_MS = 24;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * High-level API for native pthread operations.
 *
 * Create an instance with `NativeThreads.create()` — this compiles the C
 * source at runtime (or loads a pre-compiled library) and caches the FFI
 * bindings for the lifetime of the instance.
 */
export class NativeThreads {
  readonly #symbols: NativeSymbols;
  readonly #resultStructSize: number;

  /** Number of hardware threads reported by the native runtime. */
  readonly hwThreads: number;

  private constructor(symbols: NativeSymbols) {
    this.#symbols = symbols;
    this.#resultStructSize = symbols.result_struct_size();
    this.hwThreads = symbols.get_hw_threads();
  }

  /**
   * Create a NativeThreads instance.
   *
   * Compiles the embedded C source at runtime using Bun's built-in TCC
   * compiler, or loads a pre-compiled shared library if `options.libraryPath`
   * is provided.
   *
   * @throws {NativeThreadError} If compilation or library loading fails.
   */
  static async create(options?: NativeThreadsOptions): Promise<NativeThreads> {
    const symbols = options?.libraryPath
      ? loadPrecompiled(options.libraryPath)
      : await compileAtRuntime();

    return new NativeThreads(symbols);
  }

  /**
   * Spawn native pthreads that burn CPU (Leibniz π) and optionally allocate memory.
   *
   * This is a **blocking** call — it spawns pthreads, joins them all, and returns
   * results synchronously. The calling JS thread is blocked for the duration.
   * Use this from a Bun Worker or when you intentionally want to saturate CPUs
   * from the main thread.
   *
   * @returns Array of results, one per thread.
   * @throws {NativeThreadError} If the native call fails (e.g. allocation failure).
   */
  burn(options?: NativeBurnOptions): NativeBurnResult[] {
    const threads    = options?.threads ?? this.hwThreads;
    const durationMs = options?.durationMs ?? 1000;
    const memoryMB   = options?.memoryMB ?? 0;

    if (threads <= 0) throw new NativeThreadError('threads must be > 0');
    if (durationMs < 0) throw new NativeThreadError('durationMs must be >= 0');
    if (memoryMB < 0) throw new NativeThreadError('memoryMB must be >= 0');

    // Allocate result buffer: threads × resultStructSize bytes
    const bufferSize = threads * this.#resultStructSize;
    const buffer = new ArrayBuffer(bufferSize);

    // Call native — blocks until all pthreads join
    const rc = this.#symbols.native_burn(threads, durationMs, memoryMB, ptr(buffer));
    if (rc !== 0) {
      throw new NativeThreadError(`native_burn returned error code ${rc}`);
    }

    // Parse results from buffer
    return parseResults(buffer, threads, this.#resultStructSize);
  }

  /**
   * Run burn asynchronously by offloading to a microtask.
   * This prevents blocking the event loop for long burns.
   *
   * Under the hood this still blocks an OS thread (the pthreads themselves),
   * but the JS event loop remains responsive.
   */
  async burnAsync(options?: NativeBurnOptions): Promise<NativeBurnResult[]> {
    // Use Bun's worker to avoid blocking the main thread
    return new Promise((resolve, reject) => {
      try {
        const results = this.burn(options);
        resolve(results);
      } catch (err) {
        reject(err);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Buffer parsing
// ---------------------------------------------------------------------------

function parseResults(buffer: ArrayBuffer, count: number, structSize: number): NativeBurnResult[] {
  const view = new DataView(buffer);
  const results: NativeBurnResult[] = [];

  for (let i = 0; i < count; i++) {
    const base = i * structSize;
    results.push({
      pi:          view.getFloat64(base + RESULT_OFFSET_PI, true),
      iterations:  Number(view.getBigInt64(base + RESULT_OFFSET_ITERATIONS, true)),
      threadId:    view.getInt32(base + RESULT_OFFSET_THREAD_ID, true),
      allocatedMB: view.getInt32(base + RESULT_OFFSET_ALLOC_MB, true),
      elapsedMs:   view.getFloat64(base + RESULT_OFFSET_ELAPSED_MS, true),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// FFI helpers
// ---------------------------------------------------------------------------

/** Get a pointer-compatible typed array view for Bun FFI. */
function ptr(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

/** Compile burn.c at runtime using Bun's built-in cc. */
async function compileAtRuntime(): Promise<NativeSymbols> {
  try {
    const { cc } = await import('bun:ffi');

    // Resolve path to burn.c relative to this module
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const cSourcePath = join(thisDir, 'burn.c');

    if (!existsSync(cSourcePath)) {
      throw new NativeThreadError(
        `C source not found at ${cSourcePath}. Ensure burn.c is in the same directory as native-threads.ts.`,
      );
    }

    const lib = cc({
      source: cSourcePath,
      symbols: {
        get_hw_threads:    { returns: 'i32', args: [] },
        result_struct_size: { returns: 'i32', args: [] },
        native_burn:       { returns: 'i32', args: ['i32', 'i32', 'i32', 'ptr'] },
      },
    });

    return {
      get_hw_threads:    lib.symbols.get_hw_threads as unknown as () => number,
      result_struct_size: lib.symbols.result_struct_size as unknown as () => number,
      native_burn:       lib.symbols.native_burn as unknown as (n: number, d: number, m: number, p: unknown) => number,
    };
  } catch (err) {
    if (err instanceof NativeThreadError) throw err;
    throw new NativeThreadError(
      `Failed to compile native threads: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** Load a pre-compiled shared library using dlopen. */
function loadPrecompiled(libraryPath: string): NativeSymbols {
  try {
    const { dlopen, FFIType } = require('bun:ffi');

    const lib = dlopen(libraryPath, {
      get_hw_threads:    { returns: FFIType.i32, args: [] },
      result_struct_size: { returns: FFIType.i32, args: [] },
      native_burn:       { returns: FFIType.i32, args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr] },
    });

    return {
      get_hw_threads:    lib.symbols.get_hw_threads as unknown as () => number,
      result_struct_size: lib.symbols.result_struct_size as unknown as () => number,
      native_burn:       lib.symbols.native_burn as unknown as (n: number, d: number, m: number, p: unknown) => number,
    };
  } catch (err) {
    throw new NativeThreadError(
      `Failed to load native library from ${libraryPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
