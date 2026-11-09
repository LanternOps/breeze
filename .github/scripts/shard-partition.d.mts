// Types for the part of shard-partition.mjs that apps/api/vitest.integration.config.ts
// imports. apps/api's test type check reaches that config through
// integration-suite-coverage.integration.test.ts.

export declare const TIMINGS_PATH: string;

export interface ShardPlan {
  index: number;
  count: number;
  total: number;
  files: string[];
  projectedSeconds: number;
  planDigest: string;
}

export declare function timingShard<Spec extends { moduleId: string }, Fallback>(
  specs: Spec[],
  options: {
    index: number;
    count: number;
    repoRoot?: string;
    timingsText: string | null;
    timingsError?: string;
    fallback: () => Fallback;
    log?: (line: string) => void;
    writePlan?: (plan: ShardPlan) => void;
  },
): Spec[] | Fallback;
