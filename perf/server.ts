/**
 * Scatter — Performance burn server.
 *
 * POST /burn  → saturate every CPU core + fill memory to the container limit.
 * GET  /      → usage instructions.
 *
 * Designed to run inside a resource-constrained Docker container so you can
 * observe 100% CPU and near-max memory in `docker stats`.
 *
 * Usage:
 *   docker compose -f perf/docker-compose.yml up --build
 *   curl -X POST http://localhost:3000/burn
 *   # In another terminal: docker stats
 */

import { scatter } from '../src/runtime/index.js';
import { cpus, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Container-aware resource detection
// ---------------------------------------------------------------------------

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

function detectCPUs(): number {
  const envOverride = parseInt(process.env.CPUS ?? '', 10);
  if (envOverride > 0) return envOverride;

  try {
    const cpuMax = readFileSync('/sys/fs/cgroup/cpu.max', 'utf-8');
    const detected = parseCpuLimit(cpuMax);
    if (detected !== null) return detected;
  } catch {}

  try {
    const quota = parseInt(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf-8').trim(), 10);
    const period = parseInt(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf-8').trim(), 10);
    if (quota > 0 && period > 0) {
      return Math.max(1, Math.floor(quota / period));
    }
  } catch {}

  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0) {
    return navigator.hardwareConcurrency;
  }

  return cpus().length;
}

function detectMemoryMB(): number {
  const envOverride = parseMemoryOverrideMB(process.env.MEMORY_MB);
  if (envOverride !== null && envOverride > 0) return envOverride;

  // cgroup v2
  try {
    const text = readFileSync('/sys/fs/cgroup/memory.max', 'utf-8');
    const detected = parseCgroupMemoryLimitMB(text);
    if (detected !== null) {
      return detected;
    }
  } catch {}

  // cgroup v1
  try {
    const text = readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf-8');
    const limit = parseCgroupMemoryLimitMB(text);
    const total = totalmem();
    if (limit !== null && limit > 0 && limit * 1024 * 1024 < total) {
      return limit;
    }
  } catch {}

  return Math.floor(totalmem() / (1024 * 1024));
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT       = parseInt(process.env.PORT ?? '3000', 10);
const NUM_CPUS   = detectCPUs();
const MEMORY_MB  = detectMemoryMB();

// ---------------------------------------------------------------------------
// Pre-warm a pool with one worker per CPU
// ---------------------------------------------------------------------------

/**
 * The worker function is completely self-contained — no closures.
 * Everything arrives through `input`.
 *
 * Phase 1: Allocate + fill memory buffers (forces RSS)
 * Phase 2: CPU burn — Leibniz pi for `durationSec` seconds
 * Phase 3: Checksum over allocated memory (prevents GC)
 */
const pool = scatter.pool(
  (_ctx: any, input: any) => {
    const { workerId, memoryMB, durationSec } = input;

    // ---- Phase 1: Memory saturation -----------------------------------
    const chunks: Uint8Array[] = [];
    if (memoryMB > 0) {
      const targetBytes = memoryMB * 1024 * 1024;
      let allocated = 0;
      while (allocated < targetBytes) {
        const size = Math.min(4 * 1024 * 1024, targetBytes - allocated);
        const buf = new Uint8Array(size);
        // Touch every byte — forces the OS to commit physical pages.
        // Uses Knuth multiplicative hash for a non-trivial write pattern.
        for (let i = 0; i < size; i++) {
          buf[i] = ((i * 2654435761) >>> 0) & 0xff;
        }
        chunks.push(buf);
        allocated += size;
      }
    }
    const allocatedMB = chunks.reduce((s, c) => s + c.length, 0) / (1024 * 1024);

    // ---- Phase 2: CPU burn — Leibniz series ---------------------------
    //
    //   π/4 = 1 - 1/3 + 1/5 - 1/7 + ...
    //
    // Each worker offsets its starting term so the partial sums are
    // different (makes merging more interesting, but we don't bother
    // merging — the point is sustained 100% CPU).
    const endTime = Date.now() + durationSec * 1000;
    let k = 0;
    let sum = 0;
    let totalIterations = 0;

    while (Date.now() < endTime) {
      // Batch 200K iterations between Date.now() checks (cheap amortisation)
      for (let batch = 0; batch < 200_000; batch++) {
        sum += (k & 1 ? -1 : 1) / (2 * k + 1);
        k++;
      }
      totalIterations += 200_000;
    }
    const pi = sum * 4;

    // ---- Phase 3: Memory liveness check -------------------------------
    let checksum = 0;
    for (const chunk of chunks) {
      checksum += chunk[0] + chunk[chunk.length - 1];
    }

    return {
      pi,
      workerId,
      allocatedMB: Math.round(allocatedMB),
      totalIterations,
      iterationsPerSec: Math.round(totalIterations / durationSec),
      checksum,
    };
  },
  { size: NUM_CPUS },
);

// Warmup: ensure every worker has booted and processed INIT
const warmupStart = performance.now();
const warmupPromises = Array.from({ length: NUM_CPUS }, (_, i) =>
  pool.exec({ workerId: i, durationSec: 0.01, memoryMB: 0 }),
);
await Promise.all(warmupPromises);
const warmupMs = Math.round(performance.now() - warmupStart);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const BANNER = [
  '',
  '  ┌─────────────────────────────────────────────────┐',
  '  │            scatter perf-burn server              │',
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
  '  Monitor:',
  '    docker stats',
  '',
].join('\n');

console.log(BANNER);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // ---- POST /burn ---------------------------------------------------
    if (req.method === 'POST' && url.pathname === '/burn') {
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        // No body or invalid JSON — use defaults
      }

      const durationSec    = Number(body.durationSec ?? 15);
      const memoryPercent  = Number(body.memoryPercent ?? 80);
      const totalMemoryTargetMB = Math.max(0, Math.floor(MEMORY_MB * memoryPercent / 100));
      const memoryAssignmentsMB = buildMemoryAssignments(totalMemoryTargetMB, NUM_CPUS);
      const maxMemoryPerWorkerMB = memoryAssignmentsMB.length > 0 ? Math.max(...memoryAssignmentsMB) : 0;
      const workersAllocatingMemory = memoryAssignmentsMB.filter((memoryMB) => memoryMB > 0).length;

      console.log(
        `[burn] ${NUM_CPUS} workers × ${durationSec}s × up to ${maxMemoryPerWorkerMB} MB/worker  ` +
        `(${totalMemoryTargetMB} MB total, ${workersAllocatingMemory} worker(s) allocating, ` +
        `${memoryPercent}% of ${MEMORY_MB} MB)`,
      );

      const start = performance.now();

      // Fire one task per worker simultaneously → all CPUs peg 100%
      const tasks = Array.from({ length: NUM_CPUS }, (_, i) =>
        pool.exec({
          workerId: i,
          durationSec,
          memoryMB: memoryAssignmentsMB[i] ?? 0,
        }),
      );
      const results = await Promise.all(tasks);

      const elapsedMs = Math.round(performance.now() - start);
      const avgPi     = results.reduce((s: number, r: any) => s + r.pi, 0) / results.length;

      console.log(`[burn] done in ${elapsedMs} ms — π ≈ ${avgPi}`);

      return Response.json({
        pi:                  avgPi,
        piError:             Math.abs(avgPi - Math.PI),
        workers:             NUM_CPUS,
        durationSec,
        memoryPerWorkerMB:   maxMemoryPerWorkerMB,
        workersAllocatingMemory,
        totalMemoryTargetMB,
        containerMemoryMB:   MEMORY_MB,
        elapsedMs,
        results,
      });
    }

    // ---- GET / --------------------------------------------------------
    return new Response(
      [
        'scatter perf-burn server',
        `CPUs: ${NUM_CPUS}  |  Memory: ${MEMORY_MB} MB`,
        '',
        'POST /burn',
        '  Body (JSON, all optional):',
        '    durationSec   — how long each worker burns CPU  (default: 15)',
        '    memoryPercent  — % of container memory to fill   (default: 80)',
        '',
        'Examples:',
        `  curl -s -X POST http://localhost:${PORT}/burn | jq .`,
        `  curl -s -X POST http://localhost:${PORT}/burn -H "Content-Type: application/json" -d '{"durationSec":30,"memoryPercent":90}' | jq .`,
      ].join('\n'),
      { headers: { 'content-type': 'text/plain' } },
    );
  },
});
