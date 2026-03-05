import { WorkerClass } from '../src/decorators/index.js';
import type { WorkerClassStatic, WorkerProxied } from '../src/decorators/index.js';

@WorkerClass({ pool: 2 })
class WorkerScoreService {
  constructor(private readonly weight: number) {}

  calculateWeightedTotal(scores: number[]): number {
    return scores.reduce((sum, score) => sum + score * this.weight, 0);
  }
}

const WorkerScoreClass = WorkerScoreService as WorkerClassStatic<typeof WorkerScoreService>;
const service = new WorkerScoreService(3) as unknown as WorkerProxied<WorkerScoreService>;
const scores = [4, 7, 9, 10];
const weightedTotal = await service.calculateWeightedTotal(scores);

console.log('Scatter class decorator example');
console.log(`scores: ${scores.join(', ')}`);
console.log('pool size: 2');
console.log(`weighted total: ${weightedTotal}`);

await WorkerScoreClass.disposeWorkers();
