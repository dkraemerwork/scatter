# scatter

Inline Bun workers with lock-free shared-memory channels. Scatter your work across all cores.

npm: [`@zenystx/scatterjs`](https://www.npmjs.com/package/@zenystx/scatterjs)

## Goals

- **Zero boilerplate** — pass a function, get a thread. No separate worker files, no build step.
- **Zero dependencies** - don't worry about outdated external libraries
- **Real OS threads** — every Bun Worker maps 1:1 to an OS thread. No green threads, no fake parallelism.
- **Shared memory by default** — channels use `SharedArrayBuffer` ring buffers with lock-free atomics. No serialization overhead for binary codecs.
- **Progressive API** — start with `scatter()` for a one-liner, scale up to pools, streaming channels, or full core saturation without changing your mental model.
- **Native escape hatch** — when JS Workers aren't enough, drop to raw pthreads via `bun:ffi` with zero overhead.

## Design Choices

- **Bun-only** — built for Bun's runtime. Not a polyfill, not browser-compatible. Uses Blob workers, `SharedArrayBuffer`, `Atomics.waitAsync`, and `bun:ffi` directly.
- **Lock-free ring buffers** — channels are backed by a single `SharedArrayBuffer` with atomic head/tail pointers. No mutexes, no kernel transitions for fast-path reads/writes.
- **Structured clone as default codec** — values cross the channel boundary via structured clone. Swap to `'json'`, `'number'`, `'string'`, `'raw'`, or a custom `Codec<T>` when you need control.
- **`using` / `Symbol.dispose`** — pools, spawn handles, and channels implement `Disposable` so cleanup is automatic with TC39 explicit resource management.
- **Worker functions are isolated** — the function you pass runs in a separate V8 isolate. No closures, no shared state except through channels and `ctx.data`. This is a feature, not a limitation.
- **Errors cross the boundary** — worker exceptions are serialized, shipped back, and reconstructed as `ThreadExecutionError` with the original name, message, and stack intact.

## Usage

```bash
bun add @zenystx/scatterjs
```

```ts
import { scatter, Channel, createCodec } from '@zenystx/scatterjs';
```

Custom codecs can be created with `createCodec(...)` or passed as plain objects. For `scatter.spawn()` they must be self-contained functions, just like worker functions.

### Custom codecs

```ts
const jsonLinesCodec = createCodec<{ id: number; name: string }>({
  name: 'json-lines',
  encode(value) {
    return new TextEncoder().encode(JSON.stringify(value));
  },
  decode(buffer) {
    return JSON.parse(new TextDecoder().decode(buffer)) as {
      id: number;
      name: string;
    };
  },
});

using handle = scatter.spawn(
  async (ctx) => {
    const input = ctx.channel('input');
    const output = ctx.channel('output');

    for await (const value of input) {
      output.write({ ...value, name: value.name.toUpperCase() });
    }

    output.close();
  },
  {
    channels: {
      input: Channel.in<{ id: number; name: string }>({ codec: jsonLinesCodec }),
      output: Channel.out<{ id: number; name: string }>({ codec: jsonLinesCodec }),
    },
  },
);
```

Rules for custom codecs:

- `encode` must return a `Uint8Array` and `decode` must reverse it.
- Give each codec a stable `name`.
- For `scatter.spawn()`, `encode` and `decode` are rehydrated inside the worker from their function source, so keep them self-contained.
- If a codec depends on external packages, provide those packages to the worker with the `imports` option and reference them from globals or imported module state inside the codec functions.
- Built-in names are still simpler when they fit: `'structured'`, `'json'`, `'string'`, `'number'`, and `'raw'`.

Five API tiers, one import:

| Tier | Function | Purpose |
|------|----------|---------|
| One-shot | `scatter(fn)` | Run a function on a thread, get the result |
| Spawn | `scatter.spawn(fn, opts)` | Long-lived worker with typed shared-memory channels |
| Pool | `scatter.pool(fn, opts)` | N pre-warmed workers with automatic task dispatch |
| Max | `scatter.max(fn, opts)` | Saturate every CPU core for a bounded computation |
| Native | `NativeThreads.create()` | Raw pthreads via bun:ffi for maximum throughput |

Optional decorator entrypoint:

```ts
import {
  Scaled,
  WorkerClass,
  cleanupAllDecoratorPools,
} from '@zenystx/scatterjs/decorators';
```

The decorator API stays separate so the core `@zenystx/scatterjs` import remains zero-overhead for users who
only want the runtime primitives.

## Examples

### One-shot

```ts
const result = await scatter((ctx) => {
  let sum = 0;
  for (let i = 0; i < 1_000_000_000; i++) sum += i;
  return sum;
});
```

### Pool

```ts
using pool = scatter.pool(
  (ctx, n: number) => {
    // runs on a worker thread
    let count = 0;
    for (let i = 2; i <= n; i++) {
      let prime = true;
      for (let j = 2; j * j <= i; j++) {
        if (i % j === 0) { prime = false; break; }
      }
      if (prime) count++;
    }
    return count;
  },
  { size: 8 },
);

const count = await pool.exec(10_000_000);
```

### Spawn with channels

```ts
using handle = scatter.spawn(
  async (ctx) => {
    const input = ctx.channel('tasks');
    const output = ctx.channel('results');

    for await (const task of input) {
      output.write(task.value * 2);
    }
    output.close();
  },
  {
    channels: {
      tasks:   Channel.in<{ value: number }>(),
      results: Channel.out<number>(),
    },
  },
);

handle.channels.tasks.write({ value: 21 });
const doubled = await handle.channels.results.readAsync(); // 42
```

### Max — saturate all cores

```ts
const partialSums = await scatter.max(
  (ctx, chunk: number[]) => chunk.reduce((a, b) => a + b, 0),
  {
    input: Array.from({ length: 10_000_000 }, (_, i) => i),
    split: (arr, n) => Array.from({ length: n }, (_, i) =>
      arr.slice(
        Math.floor((i / n) * arr.length),
        Math.floor(((i + 1) / n) * arr.length),
      ),
    ),
  },
).collect();

const total = partialSums.reduce((a, b) => a + b, 0);
```

## Decorators

Decorators are opt-in via `@zenystx/scatterjs/decorators`.

- `@Scaled()` offloads a single method; default mode is one-shot and `@Scaled({ pool: N })` reuses a shared pool.
- `@WorkerClass()` proxies public prototype methods through a per-class shared worker pool.
- Decorated methods return `Promise<...>` at runtime.
- Type helpers are available for exact annotations: `ScaledMethod`, `WorkerProxied`, and `WorkerClassStatic`.
- Instance state is snapshot-serialized before each call; non-serializable fields such as functions are dropped.

### `@Scaled()`

```ts
import { Scaled, cleanupAllDecoratorPools } from '@zenystx/scatterjs/decorators';

class ScoreService {
  multiplier = 3;

  @Scaled()
  calculateWeightedTotal(scores: number[]): number {
    return scores.reduce((sum, score) => sum + score * this.multiplier, 0);
  }
}

const service = new ScoreService();
const total = await service.calculateWeightedTotal([4, 7, 9, 10]);

await cleanupAllDecoratorPools();
```

### `@WorkerClass()`

```ts
import { WorkerClass } from '@zenystx/scatterjs/decorators';
import type { WorkerClassStatic, WorkerProxied } from '@zenystx/scatterjs/decorators';

@WorkerClass({ pool: 4 })
class ImageService {
  quality = 2;

  resize(width: number, height: number): number {
    return width * height * this.quality;
  }
}

const ImageServiceClass = ImageService as WorkerClassStatic<typeof ImageService>;
const service = new ImageService() as unknown as WorkerProxied<ImageService>;
const pixels = await service.resize(800, 600);

await ImageServiceClass.disposeWorkers();
```

## Repo Examples

- `bun run examples/scaled-basic.ts`
- `bun run examples/worker-class-basic.ts`
- `bun run perf/server.ts`
- `bun run perf/server-worker-class.ts`

## Native pthreads

```ts
import { NativeThreads } from '@zenystx/scatterjs';

const native = await NativeThreads.create();

// Burn all cores for 2 seconds
const results = native.burn({ durationMs: 2000 });

for (const r of results) {
  console.log(`Thread ${r.threadId}: pi=${r.pi} (${r.iterations} iters in ${r.elapsedMs}ms)`);
}
```

## Config Options

### `scatter(fn, options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | none | Max execution time in ms. Worker is killed if exceeded. |
| `signal` | `AbortSignal` | none | External cancellation. Aborting kills the worker. |
| `imports` | `string[]` | `[]` | Module specifiers injected as imports inside the worker. |
| `data` | `Record<string, unknown>` | `{}` | Serializable data available as `ctx.data` in the worker. |

### `scatter.pool(fn, options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `size` | `number` | `navigator.hardwareConcurrency` | Number of workers in the pool. |
| `concurrency` | `number` | `1` | Tasks each worker handles simultaneously. |
| `maxQueue` | `number` | unbounded | Max queued tasks before backpressure. |
| `strategy` | `'round-robin' \| 'least-busy'` | `'round-robin'` | How tasks are dispatched to workers. |
| `imports` | `string[]` | `[]` | Module specifiers for workers. |
| `data` | `Record<string, unknown>` | `{}` | Shared data for all workers. |

### `scatter.spawn(fn, options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `channels` | `Record<string, ChannelDef>` | required | Named channel definitions using `Channel.in()` / `Channel.out()`. |
| `imports` | `string[]` | `[]` | Module specifiers for the worker. |
| `data` | `Record<string, unknown>` | `{}` | Shared data for the worker. |
| `signal` | `AbortSignal` | none | External cancellation. |

### `Channel.in<T>(options?)` / `Channel.out<T>(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `capacity` | `number` | `65536` | Ring buffer size in bytes. |
| `codec` | `CodecLike<T>` | `'structured'` | Serialization codec: `'raw'`, `'number'`, `'string'`, `'json'`, `'structured'`, or custom. Custom codecs are rehydrated inside workers from their function source. |

### `scatter.max(fn, options)`

**Batch overload** — pre-divided inputs:

| Option | Type | Description |
|--------|------|-------------|
| `inputs` | `Iterable<TIn>` | Each item is dispatched to one worker. |
| `imports` | `string[]` | Module specifiers. |
| `data` | `Record<string, unknown>` | Shared data. |
| `signal` | `AbortSignal` | Cancellation. |

**Split overload** — auto-divide a single input:

| Option | Type | Description |
|--------|------|-------------|
| `input` | `TIn` | The full input to split. |
| `split` | `(input: TIn, n: number) => Iterable<TIn>` | Divides input into `n` chunks (one per core). |

### `NativeThreads.burn(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `threads` | `number` | all cores | Number of native pthreads to spawn. |
| `durationMs` | `number` | `1000` | CPU burn duration per thread (ms). |
| `memoryMB` | `number` | `0` | Memory each thread allocates and touches (MB). |
