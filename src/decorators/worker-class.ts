import type { PoolWorkerContext } from '../context.js';
import type { ThreadPool } from '../scatter.js';
import { scatter } from '../runtime/index.js';
import { normalizeMethodSource } from './build-worker-fn.js';
import type { WorkerPayload } from './build-worker-fn.js';
import { allDecoratorPools } from './scaled.js';
import { serializeState } from './serialize-state.js';

export interface WorkerClassOptions {
  readonly pool?: number | boolean;
  readonly concurrency?: number;
  readonly strategy?: 'round-robin' | 'least-busy';
  readonly imports?: readonly string[];
  readonly maxQueue?: number;
}

interface ClassDispatchPayload extends WorkerPayload {
  readonly __method: string;
}

type WorkerClassConstructor = new (...args: any[]) => object;

type Stage3ClassContext<T extends WorkerClassConstructor> = ClassDecoratorContext<T>;

export type WorkerProxied<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K];
};

export type WorkerClassStatic<T extends new (...args: any[]) => unknown> = T & {
  disposeWorkers(): Promise<void>;
};

function collectWorkerMethodNames(OriginalClass: WorkerClassConstructor): Set<string> {
  const methodNames = new Set<string>();

  for (const name of Object.getOwnPropertyNames(OriginalClass.prototype)) {
    if (name === 'constructor' || name.startsWith('_')) continue;

    const descriptor = Object.getOwnPropertyDescriptor(OriginalClass.prototype, name);
    if (!descriptor || typeof descriptor.value !== 'function') continue;

    methodNames.add(name);
  }

  return methodNames;
}

function buildClassDispatcherSource(
  OriginalClass: WorkerClassConstructor,
  methodNames: Iterable<string>,
): string {
  const methodEntries: string[] = [];

  for (const name of methodNames) {
    const method = Object.getOwnPropertyDescriptor(OriginalClass.prototype, name)?.value;
    if (typeof method !== 'function') continue;

    methodEntries.push(`  ${JSON.stringify(name)}: ${normalizeMethodSource(method.toString())}`);
  }

  return [
    'const __methods = {',
    methodEntries.join(',\n'),
    '};',
    'const __state = input.__state ?? {};',
    'const __safeState = {};',
    'for (const __key of Object.keys(__state)) {',
    '  if (!Object.prototype.hasOwnProperty.call(__methods, __key)) {',
    '    __safeState[__key] = __state[__key];',
    '  }',
    '}',
    'const __self = Object.assign(Object.create(__methods), __safeState);',
    'const __method = __methods[input.__method];',
    'if (typeof __method !== "function") {',
    '  throw new Error(`[scatter] @WorkerClass: unknown method: ${input.__method}`);',
    '}',
    'return __method.apply(__self, input.__args ?? []);',
  ].join('\n');
}

function resolvePoolSize(options?: WorkerClassOptions): number {
  if (options?.pool === false) {
    throw new TypeError(
      '[scatter] @WorkerClass: pool: false is not valid. Omit it for auto sizing or pass a positive integer.',
    );
  }

  const rawPoolSize = options?.pool === undefined || options.pool === true
    ? ((typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) ?? 4)
    : options.pool;

  if (typeof rawPoolSize !== 'number' || rawPoolSize < 1 || !Number.isInteger(rawPoolSize)) {
    throw new TypeError(
      `[scatter] @WorkerClass: pool size must be a positive integer, got ${rawPoolSize}`,
    );
  }

  return rawPoolSize;
}

function resolveConcurrency(options?: WorkerClassOptions): number {
  const concurrency = options?.concurrency ?? 1;

  if (typeof concurrency !== 'number' || concurrency < 1 || !Number.isInteger(concurrency)) {
    throw new TypeError(
      `[scatter] @WorkerClass: concurrency must be a positive integer, got ${concurrency}`,
    );
  }

  return concurrency;
}

function createProxyHandler(
  target: object,
  pool: ThreadPool<ClassDispatchPayload, unknown>,
  methodNames: ReadonlySet<string>,
): ProxyHandler<object> {
  const wrapperCache = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  return {
    get(actualTarget, prop, receiver) {
      if (typeof prop !== 'string' || prop.startsWith('_') || !methodNames.has(prop)) {
        return Reflect.get(actualTarget, prop, receiver);
      }

      const cachedWrapper = wrapperCache.get(prop);
      if (cachedWrapper) return cachedWrapper;

      const wrapper = async (...args: unknown[]): Promise<unknown> => {
        const state = serializeState(target);
        return pool.exec({ __method: prop, __args: args, __state: state });
      };

      wrapperCache.set(prop, wrapper);
      return wrapper;
    },
  };
}

function createWorkerClassDecorator<T extends WorkerClassConstructor>(
  OriginalClass: T,
  options?: WorkerClassOptions,
): T {
  const methodNames = collectWorkerMethodNames(OriginalClass);
  const poolSize = resolvePoolSize(options);
  const concurrency = resolveConcurrency(options);
  const dispatcherSource = buildClassDispatcherSource(OriginalClass, methodNames);
  const poolWorkerFn = new Function(
    'ctx',
    'input',
    dispatcherSource,
  ) as (ctx: PoolWorkerContext, input: ClassDispatchPayload) => unknown;

  let pool: ThreadPool<ClassDispatchPayload, unknown> | null = null;

  const getPool = (): ThreadPool<ClassDispatchPayload, unknown> => {
    if (pool) return pool;

    pool = scatter.pool(poolWorkerFn, {
      size: poolSize,
      concurrency,
      strategy: options?.strategy ?? 'round-robin',
      imports: options?.imports as string[] | undefined,
      ...(options?.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
    });

    allDecoratorPools.add(pool);
    return pool;
  };

  class WorkerClassReplacement extends OriginalClass {
    static async disposeWorkers(): Promise<void> {
      if (!pool) return;

      const poolToDispose = pool;
      pool = null;

      try {
        await poolToDispose.shutdown();
      } finally {
        allDecoratorPools.delete(poolToDispose);
      }
    }

    static [Symbol.asyncDispose](): Promise<void> {
      return this.disposeWorkers();
    }

    constructor(...args: any[]) {
      super(...args);
      return new Proxy(this, createProxyHandler(this, getPool(), methodNames));
    }
  }

  return WorkerClassReplacement as unknown as T;
}

function isStage3ClassDecoratorCall<T extends WorkerClassConstructor>(
  decoratorArgs: unknown[],
): decoratorArgs is [T, Stage3ClassContext<T>] {
  if (decoratorArgs.length !== 2) return false;

  const [value, context] = decoratorArgs;
  return typeof value === 'function'
    && typeof context === 'object'
    && context !== null
    && 'kind' in context
    && (context as { kind?: unknown }).kind === 'class';
}

function isLegacyClassDecoratorCall<T extends WorkerClassConstructor>(
  decoratorArgs: unknown[],
): decoratorArgs is [T] {
  return decoratorArgs.length === 1 && typeof decoratorArgs[0] === 'function';
}

export function WorkerClass(options?: WorkerClassOptions): <T extends WorkerClassConstructor>(
  value: T,
  context: ClassDecoratorContext<T>,
) => T {
  return function <T extends WorkerClassConstructor>(...decoratorArgs: unknown[]): any {
    if (isStage3ClassDecoratorCall<T>(decoratorArgs)) {
      const [OriginalClass] = decoratorArgs;
      return createWorkerClassDecorator(OriginalClass, options);
    }

    if (isLegacyClassDecoratorCall<T>(decoratorArgs)) {
      const [OriginalClass] = decoratorArgs;
      return createWorkerClassDecorator(OriginalClass, options);
    }

    throw new TypeError('[scatter] @WorkerClass received an unsupported decorator shape');
  };
}
