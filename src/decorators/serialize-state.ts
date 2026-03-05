/**
 * Extracts own enumerable properties from an instance, filtering out
 * non-serializable values. Used by @Scaled and @WorkerClass to snapshot
 * `this` before sending to a worker thread.
 *
 * Non-serializable fields (functions, symbols, WeakMaps, etc.) are
 * silently dropped — this is documented behavior.
 */
export function serializeState(instance: object): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const key of Object.keys(instance)) {
    const val = (instance as Record<string, unknown>)[key];
    if (isSerializable(val)) {
      state[key] = val;
    }
  }
  return state;
}

/**
 * Checks whether a value can survive structured cloning (i.e., can be
 * transferred to a worker thread).
 *
 * Fast-rejects known non-serializable types before falling back to a
 * structuredClone probe for complex objects.
 */
export function isSerializable(val: unknown): boolean {
  if (val === null) return true;

  const t = typeof val;
  if (t === 'function' || t === 'symbol' || t === 'undefined') return false;

  // Primitives (string, number, boolean, bigint) are always serializable
  if (t !== 'object') return true;

  if (val instanceof WeakMap || val instanceof WeakSet || val instanceof WeakRef) return false;

  // For complex objects, attempt structuredClone as the definitive check
  try {
    structuredClone(val);
    return true;
  } catch {
    return false;
  }
}
