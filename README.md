# scatter

Inline Bun workers with lock-free shared-memory channels. Scatter your work across all cores.

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
bun add scatter
```

```ts
import { scatter, Channel } from 'scatter';
```

Five API tiers, one import:

| Tier | Function | Purpose |
|------|----------|---------|
| One-shot | `scatter(fn)` | Run a function on a thread, get the result |
| Spawn | `scatter.spawn(fn, opts)` | Long-lived worker with typed shared-memory channels |
| Pool | `scatter.pool(fn, opts)` | N pre-warmed workers with automatic task dispatch |
| Max | `scatter.max(fn, opts)` | Saturate every CPU core for a bounded computation |
| Native | `NativeThreads.create()` | Raw pthreads via bun:ffi for maximum throughput |

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

### Native pthreads

```ts
import { NativeThreads } from 'scatter';

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
| `codec` | `CodecLike<T>` | `'structured'` | Serialization codec: `'raw'`, `'number'`, `'string'`, `'json'`, `'structured'`, or custom. |

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
