import { Scaled } from '../src/decorators/scaled.js';

class ScoreService {
  constructor(private readonly weight: number) {}

  // @ts-expect-error Stage 3 decorators cannot express the Promise-wrapped return type.
  @Scaled()
  calculateWeightedTotal(scores: number[]): number {
    return scores.reduce((sum, score) => sum + score * this.weight, 0);
  }
}

const service = new ScoreService(3);
const scores = [4, 7, 9, 10];
const weightedTotal = await service.calculateWeightedTotal(scores);

console.log('Scatter decorator example');
console.log(`scores: ${scores.join(', ')}`);
console.log(`weight: 3`);
console.log(`weighted total: ${weightedTotal}`);
