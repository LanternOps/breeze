// Types for the part of shard-partition.mjs that apps/api/vitest.integration.config.ts
// imports. apps/api's test type check reaches that config through
// integration-suite-coverage.integration.test.ts.

export declare const TIMINGS_PATH: string;
export declare const SUITE_MAP_PATH: string;
export declare const EMPTY_SHARD_SENTINEL: string;

// W07b2: what the run's named-suite selection chose, in every shard's plan.
export interface SuiteSelectionRecord {
  mode: 'shadow' | 'enforce';
  suites: 'all' | string[];
  wouldRun: number;
  total: number;
  digest: string;
}

export interface ShardPlan {
  index: number;
  count: number;
  total: number;
  files: string[];
  projectedSeconds: number;
  planDigest: string;
  selection?: SuiteSelectionRecord;
}

export declare function timingShard<Spec extends { moduleId: string }, Fallback>(
  specs: Spec[],
  options: {
    index: number;
    count: number;
    repoRoot?: string;
    timingsText: string | null;
    timingsError?: string;
    fallback: (specs: Spec[]) => Fallback;
    log?: (line: string) => void;
    writePlan?: (plan: ShardPlan) => void;
    // The integration-test job's BREEZE_INTEGRATION_SUITES(_MODE) and the map text.
    selection?: {
      suites?: string;
      mode?: string;
      mapText: string | null;
      mapError?: string;
    };
  },
): Spec[] | Fallback;
