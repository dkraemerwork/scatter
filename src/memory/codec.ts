/**
 * Scatter — Codec contract and built-in implementations.
 *
 * A codec transforms typed values to/from raw bytes for transit through
 * a SharedRingBuffer. Users can supply custom codecs or use built-in names.
 *
 * Built-in codecs (resolved by name via {@link resolveCodec}):
 *   - `'raw'`        — {@link RAW_CODEC}
 *   - `'number'`     — {@link NUMBER_CODEC}
 *   - `'string'`     — {@link STRING_CODEC}
 *   - `'json'`       — {@link JSON_CODEC}
 *   - `'structured'` — {@link STRUCTURED_CODEC}
 */

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

/** Symmetric encoder/decoder for a single value type. */
export interface Codec<T> {
  /** Unique name used for codec resolution across the worker boundary. */
  readonly name: string;

  /** Serialize a value to bytes. Must be deterministic for a given input. */
  encode(value: T): Uint8Array;

  /** Deserialize bytes back to a value. Inverse of encode. */
  decode(buffer: Uint8Array): T;
}

// ---------------------------------------------------------------------------
// Built-in codec names (resolved at runtime by the codec registry)
// ---------------------------------------------------------------------------

/** Names of codecs that ship with scatter. */
export type BuiltinCodecName = 'raw' | 'number' | 'string' | 'json' | 'structured';

/**
 * Codec specifier — either a concrete Codec instance or a built-in name.
 * When a name is given, scatter resolves it via {@link resolveCodec}.
 */
export type CodecLike<T> = Codec<T> | BuiltinCodecName;

/** Serialized representation used to rehydrate codecs across worker boundaries. */
export interface SerializedCodec {
  readonly name: string;
  readonly encodeSource?: string;
  readonly decodeSource?: string;
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a custom {@link Codec} from an inline spec.
 *
 * @example
 * ```ts
 * const pointCodec = createCodec<{ x: number; y: number }>({
 *   name: 'point',
 *   encode: ({ x, y }) => {
 *     const buf = new Float64Array(2);
 *     buf[0] = x; buf[1] = y;
 *     return new Uint8Array(buf.buffer);
 *   },
 *   decode: (bytes) => {
 *     const buf = new Float64Array(bytes.buffer, bytes.byteOffset, 2);
 *     return { x: buf[0], y: buf[1] };
 *   },
 * });
 * ```
 */
export function createCodec<T>(spec: {
  readonly name: string;
  encode(value: T): Uint8Array;
  decode(buffer: Uint8Array): T;
}): Codec<T> {
  return {
    name: spec.name,
    encode: spec.encode,
    decode: spec.decode,
  };
}

function normalizeFunctionSource(fnSource: string): string {
  const trimmed = fnSource.trimStart();
  const firstBraceIndex = trimmed.indexOf('{');
  const signature = firstBraceIndex === -1 ? trimmed : trimmed.slice(0, firstBraceIndex);

  if (trimmed.startsWith('function') || signature.includes('=>')) return trimmed;

  if (trimmed.startsWith('async') && trimmed.slice(5).trimStart().startsWith('*')) {
    const afterAsync = trimmed.slice(5).trimStart();
    const afterStar = afterAsync.slice(1).trimStart();
    return `async function* ${afterStar}`;
  }

  if (trimmed.startsWith('async')) {
    const afterAsync = trimmed.slice(5).trimStart();
    return `async function ${afterAsync}`;
  }

  if (trimmed.startsWith('*')) {
    const afterStar = trimmed.slice(1).trimStart();
    return `function* ${afterStar}`;
  }

  return `function ${trimmed}`;
}

function serializeFunctionSource(fn: (value: unknown) => unknown, label: string, codecName: string): string {
  const source = normalizeFunctionSource(fn.toString());
  if (source.includes('[native code]')) {
    throw new TypeError(
      `scatter: custom codec "${codecName}" cannot be materialized in a worker because ${label} is native code.`,
    );
  }
  return source;
}

// ---------------------------------------------------------------------------
// Shared encoder/decoder instances (allocated once)
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// ---------------------------------------------------------------------------
// Built-in codec implementations
// ---------------------------------------------------------------------------

/**
 * Pass-through codec for raw bytes. Zero overhead — encode/decode return the
 * same `Uint8Array` view without copying.
 *
 * @example
 * ```ts
 * const bytes = new Uint8Array([1, 2, 3]);
 * RAW_CODEC.encode(bytes) === bytes; // true (same reference)
 * ```
 */
export const RAW_CODEC: Codec<Uint8Array> = {
  name: 'raw',
  encode: (value) => value,
  decode: (buffer) => buffer,
};

/**
 * Encodes a `number` as an 8-byte IEEE 754 double (Float64, little-endian).
 *
 * @example
 * ```ts
 * const encoded = NUMBER_CODEC.encode(Math.PI);
 * NUMBER_CODEC.decode(encoded); // 3.141592653589793
 * ```
 */
export const NUMBER_CODEC: Codec<number> = {
  name: 'number',
  encode(value) {
    const f64 = new Float64Array(1);
    f64[0] = value;
    return new Uint8Array(f64.buffer);
  },
  decode(buffer) {
    const f64 = new Float64Array(buffer.buffer, buffer.byteOffset, 1);
    return f64[0];
  },
};

/**
 * Encodes a `string` as UTF-8 bytes using {@link TextEncoder} / {@link TextDecoder}.
 *
 * @example
 * ```ts
 * const encoded = STRING_CODEC.encode('hello');
 * STRING_CODEC.decode(encoded); // 'hello'
 * ```
 */
export const STRING_CODEC: Codec<string> = {
  name: 'string',
  encode: (value) => TEXT_ENCODER.encode(value),
  decode: (buffer) => TEXT_DECODER.decode(buffer),
};

/**
 * Encodes any JSON-serializable value via `JSON.stringify` → UTF-8.
 *
 * @example
 * ```ts
 * const encoded = JSON_CODEC.encode({ ok: true, count: 42 });
 * JSON_CODEC.decode(encoded); // { ok: true, count: 42 }
 * ```
 */
export const JSON_CODEC: Codec<unknown> = {
  name: 'json',
  encode: (value) => TEXT_ENCODER.encode(JSON.stringify(value)),
  decode: (buffer) => JSON.parse(TEXT_DECODER.decode(buffer)) as unknown,
};

/**
 * Encodes any structured-cloneable value.
 *
 * Uses Bun's `Bun.serialize` / `Bun.deserialize` when available (supports
 * `Uint8Array`, `Map`, `Set`, `Date`, circular refs, etc.). Falls back to
 * JSON if running outside Bun.
 *
 * @example
 * ```ts
 * const encoded = STRUCTURED_CODEC.encode(new Map([['key', 1]]));
 * STRUCTURED_CODEC.decode(encoded); // Map { 'key' => 1 }
 * ```
 */
export const STRUCTURED_CODEC: Codec<unknown> = (() => {
  // Bun exposes serialize/deserialize on the global Bun object (Bun >= 1.2).
  // Check for actual function existence, not just the Bun namespace.
  const hasBunSerialize =
    typeof globalThis !== 'undefined' &&
    'Bun' in globalThis &&
    typeof (globalThis as Record<string, unknown>)['Bun'] === 'object' &&
    typeof ((globalThis as unknown as Record<string, Record<string, unknown>>)['Bun'])['serialize'] === 'function';

  if (hasBunSerialize) {
    type BunGlobal = { serialize(v: unknown): Uint8Array; deserialize(b: Uint8Array): unknown };
    const bun = (globalThis as unknown as Record<string, BunGlobal>)['Bun'];
    return {
      name: 'structured',
      encode: (value) => bun.serialize(value),
      decode: (buffer) => bun.deserialize(buffer),
    };
  }

  // Fallback: delegate to JSON (loses type fidelity but works everywhere).
  return {
    name: 'structured',
    encode: (value) => TEXT_ENCODER.encode(JSON.stringify(value)),
    decode: (buffer) => JSON.parse(TEXT_DECODER.decode(buffer)) as unknown,
  };
})();

// ---------------------------------------------------------------------------
// Codec registry
// ---------------------------------------------------------------------------

/**
 * Internal mapping from {@link BuiltinCodecName} to concrete {@link Codec} instances.
 * @internal
 */
const BUILTIN_REGISTRY = new Map<BuiltinCodecName, Codec<unknown>>([
  ['raw', RAW_CODEC as Codec<unknown>],
  ['number', NUMBER_CODEC as Codec<unknown>],
  ['string', STRING_CODEC as Codec<unknown>],
  ['json', JSON_CODEC],
  ['structured', STRUCTURED_CODEC],
]);

function isBuiltinCodecInstance(codec: Codec<unknown>): boolean {
  const builtin = BUILTIN_REGISTRY.get(codec.name as BuiltinCodecName);
  return builtin === codec;
}

/**
 * Resolve a {@link CodecLike} specifier to a concrete {@link Codec} instance.
 *
 * - If given a `Codec` object, returns it unchanged.
 * - If given a built-in name string, returns the corresponding built-in codec.
 * - Throws a `TypeError` for unknown names.
 *
 * @example
 * ```ts
 * const codec = resolveCodec('json');
 * codec.encode({ hello: 'world' });
 *
 * const custom = createCodec({ name: 'x', encode: ..., decode: ... });
 * resolveCodec(custom) === custom; // true
 * ```
 *
 * @throws {TypeError} When `codec` is a string that is not a known built-in name.
 */
export function resolveCodec<T>(codec: CodecLike<T>): Codec<T> {
  if (typeof codec !== 'string') {
    return codec;
  }

  const resolved = BUILTIN_REGISTRY.get(codec as BuiltinCodecName);
  if (resolved === undefined) {
    throw new TypeError(
      `scatter: unknown codec name "${codec}". ` +
      `Built-in names are: ${[...BUILTIN_REGISTRY.keys()].join(', ')}.`,
    );
  }

  return resolved as Codec<T>;
}

export function serializeCodec(codec: Codec<unknown>): SerializedCodec {
  if (isBuiltinCodecInstance(codec)) {
    return { name: codec.name };
  }

  return {
    name: codec.name,
    encodeSource: serializeFunctionSource(codec.encode as (value: unknown) => unknown, 'encode()', codec.name),
    decodeSource: serializeFunctionSource(codec.decode as (value: unknown) => unknown, 'decode()', codec.name),
  };
}
