/// <reference types="bun" />

/**
 * Scatter — Performance burn server powered by `@WorkerClass()`.
 *
 * POST /burn  → saturate every CPU core + fill memory to the container limit.
 * GET  /      → usage instructions.
 *
 * Usage:
 *   bun run perf/server-worker-class.ts
 *   curl -X POST http://localhost:3000/burn
 */

import { WorkerClass } from '../src/decorators/index.js';
import type { WorkerProxied } from '../src/decorators/index.js';

interface BurnResult {
  readonly pi: number;
  readonly workerId: number;
  readonly allocatedMB: number;
  readonly totalIterations: number;
  readonly iterationsPerSec: number;
  readonly checksum: number;
}

function detectCPUs(): number {
  const envOverride = parseInt(Bun.env.CPUS ?? '', 10);
  if (envOverride > 0) return envOverride;

  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0) {
    return navigator.hardwareConcurrency;
  }

  return 4;
}

async function readTrimmedFile(filePath: string): Promise<string | null> {
  try {
    return (await Bun.file(filePath).text()).trim();
  } catch {
    return null;
  }
}

async function detectMemoryMB(): Promise<number> {
  const envOverride = parseInt(Bun.env.MEMORY_MB ?? '', 10);
  if (envOverride > 0) return envOverride;

  const cgroupV2Limit = await readTrimmedFile('/sys/fs/cgroup/memory.max');
  if (cgroupV2Limit !== null && cgroupV2Limit !== 'max') {
    return Math.floor(parseInt(cgroupV2Limit, 10) / (1024 * 1024));
  }

  const cgroupV1Limit = await readTrimmedFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (cgroupV1Limit !== null) {
    const limit = parseInt(cgroupV1Limit, 10);
    if (limit > 0) {
      return Math.floor(limit / (1024 * 1024));
    }
  }

  return 4096;
}

const PORT = parseInt(Bun.env.PORT ?? '3000', 10);
const NUM_CPUS = detectCPUs();
const MEMORY_MB = await detectMemoryMB();

@WorkerClass({ pool: NUM_CPUS })
class BurnWorkerService {
  readonly batchIterations = 200_000;
  readonly maxChunkBytes = 4 * 1024 * 1024;

  allocateMemory(memoryMB: number): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    if (memoryMB <= 0) return chunks;

    const targetBytes = memoryMB * 1024 * 1024;
    let allocated = 0;

    while (allocated < targetBytes) {
      const size = Math.min(this.maxChunkBytes, targetBytes - allocated);
      const buf = new Uint8Array(size);

      for (let i = 0; i < size; i++) {
        buf[i] = ((i * 2654435761) >>> 0) & 0xff;
      }

      chunks.push(buf);
      allocated += size;
    }

    return chunks;
  }

  approximatePi(durationSec: number): { pi: number; totalIterations: number } {
    const endTime = Date.now() + durationSec * 1000;
    let k = 0;
    let sum = 0;
    let totalIterations = 0;

    while (Date.now() < endTime) {
      for (let batch = 0; batch < this.batchIterations; batch++) {
        sum += (k & 1 ? -1 : 1) / (2 * k + 1);
        k++;
      }

      totalIterations += this.batchIterations;
    }

    return { pi: sum * 4, totalIterations };
  }

  checksum(chunks: Uint8Array[]): number {
    let checksum = 0;

    for (const chunk of chunks) {
      checksum += chunk[0] + chunk[chunk.length - 1];
    }

    return checksum;
  }

  runBurn(workerId: number, durationSec: number, memoryMB: number): BurnResult {
    const chunks = this.allocateMemory(memoryMB);
    const allocatedMB = chunks.reduce((sum, chunk) => sum + chunk.length, 0) / (1024 * 1024);
    const { pi, totalIterations } = this.approximatePi(durationSec);

    return {
      pi,
      workerId,
      allocatedMB: Math.round(allocatedMB),
      totalIterations,
      iterationsPerSec: durationSec > 0 ? Math.round(totalIterations / durationSec) : totalIterations,
      checksum: this.checksum(chunks),
    };
  }
}

const burnWorkers = new BurnWorkerService() as unknown as WorkerProxied<BurnWorkerService>;

const warmupStart = performance.now();
await Promise.all(
  Array.from({ length: NUM_CPUS }, (_, workerId) => burnWorkers.runBurn(workerId, 0.01, 0)),
);
const warmupMs = Math.round(performance.now() - warmupStart);

const BANNER = [
  '',
  '  ┌─────────────────────────────────────────────────┐',
  '  │      scatter perf-burn server (WorkerClass)     │',
  '  └─────────────────────────────────────────────────┘',
  '',
  `  CPUs ........ ${NUM_CPUS}`,
  `  Memory ...... ${MEMORY_MB} MB`,
  `  Pool warmed . ${warmupMs} ms`,
  `  Port ........ ${PORT}`,
  '',
  '  POST /burn   Saturate all CPUs + fill memory',
  '',
  '  Examples:',
  `    curl -s -X POST http://localhost:${PORT}/burn | jq .`,
  `    curl -s -X POST http://localhost:${PORT}/burn \\`,
  `      -H "Content-Type: application/json" \\`,
  `      -d '{"durationSec":30,"memoryPercent":90}' | jq .`,
  '',
].join('\n');

console.log(BANNER);

Bun.serve({
  port: PORT,
  async fetch(req: Request) {
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname === '/burn') {
      let body: Record<string, unknown> = {};

      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {}

      const durationSec = Number(body.durationSec ?? 15);
      const memoryPercent = Number(body.memoryPercent ?? 80);
      const perWorkerMemMB = Math.floor((MEMORY_MB * memoryPercent / 100) / NUM_CPUS);

      console.log(
        `[burn-worker-class] ${NUM_CPUS} workers × ${durationSec}s × ${perWorkerMemMB} MB/worker ` +
        `(${perWorkerMemMB * NUM_CPUS} MB total, ${memoryPercent}% of ${MEMORY_MB} MB)`,
      );

      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: NUM_CPUS }, (_, workerId) =>
          burnWorkers.runBurn(workerId, durationSec, perWorkerMemMB),
        ),
      );
      const elapsedMs = Math.round(performance.now() - start);
      const avgPi = results.reduce((sum, result) => sum + result.pi, 0) / results.length;

      console.log(`[burn-worker-class] done in ${elapsedMs} ms — π ≈ ${avgPi}`);

      return Response.json({
        pi: avgPi,
        piError: Math.abs(avgPi - Math.PI),
        workers: NUM_CPUS,
        durationSec,
        memoryPerWorkerMB: perWorkerMemMB,
        totalMemoryTargetMB: perWorkerMemMB * NUM_CPUS,
        containerMemoryMB: MEMORY_MB,
        elapsedMs,
        results,
      });
    }

    return new Response(
      [
        'scatter perf-burn server (WorkerClass)',
        `CPUs: ${NUM_CPUS}  |  Memory: ${MEMORY_MB} MB`,
        '',
        'POST /burn',
        '  Body (JSON, all optional):',
        '    durationSec    — how long each worker burns CPU (default: 15)',
        '    memoryPercent  — % of container memory to fill  (default: 80)',
        '',
        'Examples:',
        `  curl -s -X POST http://localhost:${PORT}/burn | jq .`,
        `  curl -s -X POST http://localhost:${PORT}/burn -H "Content-Type: application/json" -d '{"durationSec":30,"memoryPercent":90}' | jq .`,
      ].join('\n'),
      { headers: { 'content-type': 'text/plain' } },
    );
  },
});
