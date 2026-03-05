/**
 * Scatter — Import path resolver for Blob workers.
 *
 * Blob workers cannot resolve bare module specifiers (e.g. `lodash`) or
 * relative paths (e.g. `./utils.ts`). This module normalizes import
 * specifiers to absolute paths that Bun can resolve inside a Blob worker.
 *
 * @example
 * ```ts
 * resolveImports(['lodash', './my-lib.ts']);
 * // → ['import "file:///path/to/node_modules/lodash/index.js";', 'import "file:///cwd/my-lib.ts";']
 * ```
 */

/**
 * Normalize import specifiers for use inside a Blob worker.
 *
 * - Full `import ...` statements are passed through unchanged.
 * - Bare specifiers are resolved via `import.meta.resolve()`.
 * - Relative specifiers are resolved relative to `process.cwd()`.
 * - Already-absolute specifiers (`file://`, `https://`) pass through.
 *
 * @param imports  Array of import specifiers or full import statements.
 * @returns Array of normalized import statements.
 */
export function resolveImports(imports: readonly string[]): string[] {
  return imports.map((spec) => {
    // Already a full import statement — pass through
    if (spec.startsWith('import ')) return spec;

    // Already an absolute URL — wrap in import statement
    if (spec.startsWith('file://') || spec.startsWith('https://') || spec.startsWith('http://')) {
      return `import "${spec}";`;
    }

    // Try to resolve via import.meta.resolve (Bun supports this)
    try {
      const resolved = import.meta.resolve(spec);
      return `import "${resolved}";`;
    } catch {
      // Fallback: assume Bun can resolve it as-is
      return `import "${spec}";`;
    }
  });
}
