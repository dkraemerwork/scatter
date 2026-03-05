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

async function readTrimmedFile(filePath: string): Promise<string | null> {
  try {
    return (await Bun.file(filePath).text()).trim();
  } catch {
    return null;
  }
}

function parseMemoryOverrideMB(raw: string | undefined): number | null {
  if (!raw) return null;

  const trimmed = raw.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)([kmgt])?(?:i?b?)?$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2] ?? 'm';

  switch (unit) {
    case 'k': return Math.max(1, Math.floor(value / 1024));
    case 'm': return value;
    case 'g': return value * 1024;
    case 't': return value * 1024 * 1024;
    default: return null;
  }
}

function parseCgroupMemoryLimitMB(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'max') return null;

  if (/^\d+$/.test(trimmed)) {
    const bytes = parseInt(trimmed, 10);
    return bytes > 0 ? Math.max(1, Math.floor(bytes / (1024 * 1024))) : null;
  }

  return parseMemoryOverrideMB(trimmed);
}

function parseCpuLimit(raw: string): number | null {
  const [quotaText, periodText] = raw.trim().split(/\s+/);
  if (!quotaText || quotaText === 'max' || !periodText) return null;

  const quota = parseInt(quotaText, 10);
  const period = parseInt(periodText, 10);

  if (quota <= 0 || period <= 0) return null;
  return Math.max(1, Math.floor(quota / period));
}

async function detectCPUs(): Promise<number> {
  const envOverride = parseInt(Bun.env.CPUS ?? '', 10);
  if (envOverride > 0) return envOverride;

  const cpuMax = await readTrimmedFile('/sys/fs/cgroup/cpu.max');
  if (cpuMax !== null) {
    const detected = parseCpuLimit(cpuMax);
    if (detected !== null) return detected;
  }

  const quotaText = await readTrimmedFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const periodText = await readTrimmedFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (quotaText !== null && periodText !== null) {
    const quota = parseInt(quotaText, 10);
    const period = parseInt(periodText, 10);
    if (quota > 0 && period > 0) {
      return Math.max(1, Math.floor(quota / period));
    }
  }

  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0) {
    return navigator.hardwareConcurrency;
  }

  return 4;
}

async function detectMemoryMB(): Promise<number> {
  const envOverride = parseMemoryOverrideMB(Bun.env.MEMORY_MB);
  if (envOverride !== null && envOverride > 0) return envOverride;

  const cgroupV2Limit = await readTrimmedFile('/sys/fs/cgroup/memory.max');
  if (cgroupV2Limit !== null) {
    const detected = parseCgroupMemoryLimitMB(cgroupV2Limit);
    if (detected !== null) return detected;
  }

  const cgroupV1Limit = await readTrimmedFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (cgroupV1Limit !== null) {
    const detected = parseCgroupMemoryLimitMB(cgroupV1Limit);
    if (detected !== null) return detected;
  }

  return 4096;
}

function buildMemoryAssignments(totalMemoryMB: number, workerCount: number): number[] {
  if (workerCount < 1) return [];

  const safeTotal = Math.max(0, totalMemoryMB);
  const base = Math.floor(safeTotal / workerCount);
  let remainder = safeTotal % workerCount;

  return Array.from({ length: workerCount }, () => {
    if (remainder > 0) {
      remainder--;
      return base + 1;
    }

    return base;
  });
}

const PORT = parseInt(Bun.env.PORT ?? '3000', 10);
const NUM_CPUS = await detectCPUs();
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
      const totalMemoryTargetMB = Math.max(0, Math.floor(MEMORY_MB * memoryPercent / 100));
      const memoryAssignmentsMB = buildMemoryAssignments(totalMemoryTargetMB, NUM_CPUS);
      const maxMemoryPerWorkerMB = memoryAssignmentsMB.length > 0 ? Math.max(...memoryAssignmentsMB) : 0;
      const workersAllocatingMemory = memoryAssignmentsMB.filter((memoryMB) => memoryMB > 0).length;

      console.log(
        `[burn-worker-class] ${NUM_CPUS} workers × ${durationSec}s × up to ${maxMemoryPerWorkerMB} MB/worker ` +
        `(${totalMemoryTargetMB} MB total, ${workersAllocatingMemory} worker(s) allocating, ` +
        `${memoryPercent}% of ${MEMORY_MB} MB)`,
      );

      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: NUM_CPUS }, (_, workerId) =>
          burnWorkers.runBurn(workerId, durationSec, memoryAssignmentsMB[workerId] ?? 0),
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
        memoryPerWorkerMB: maxMemoryPerWorkerMB,
        workersAllocatingMemory,
        totalMemoryTargetMB,
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
