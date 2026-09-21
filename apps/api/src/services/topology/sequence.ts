import { topologySequenceSchema } from '@breeze/shared';

/** Compare uint64 producer counters without rounding or signed bigint coercion. */
export function compareTopologySequences(a: string, b: string): -1 | 0 | 1 {
  const left = BigInt(topologySequenceSchema.parse(a));
  const right = BigInt(topologySequenceSchema.parse(b));
  return left < right ? -1 : left > right ? 1 : 0;
}
