import type { Context } from 'hono';
import type { ReadinessEvaluator } from '../services/readiness';
import {
  summarizeConsumerReadiness,
  type PublicConsumerReadinessSummary,
} from '../services/workerReadinessRegistry';

export type PublicReadinessResponse =
  | {
      ready: boolean;
      db: boolean;
      redis: boolean;
      workers: boolean;
      checkedAt: string;
      consumerSummary: PublicConsumerReadinessSummary;
    }
  | {
      ready: false;
      db: null;
      redis: null;
      workers: null;
      checkedAt: string;
      consumerSummary: null;
      error: 'readiness evaluation failed';
    };

export interface ReadinessHandlerDeps {
  evaluator: ReadinessEvaluator;
  /**
   * Invoked when the evaluator itself fails (as opposed to a dependency being
   * unhealthy, which is a normal not-ready result). Wired to logging + Sentry.
   */
  onEvaluationError: (error: unknown, c: Context) => void;
}

/**
 * Handler for the legacy `/ready` probe.
 *
 * Split out of `index.ts` so the status-code contract can be tested: probes and
 * load balancers act on 200-vs-503, not on the body, and that mapping is the
 * only externally visible behaviour of this endpoint.
 */
export function createReadinessHandler({ evaluator, onEvaluationError }: ReadinessHandlerDeps) {
  return async (c: Context) => {
    let snapshot;
    try {
      snapshot = await evaluator.get();
    } catch (error) {
      // Probe failures resolve to `false` inside the evaluator, so reaching
      // here means the evaluator itself broke. Report not-ready — never a 500,
      // which a probe reads as an ambiguous transport failure — and make sure
      // the cause is recorded rather than swallowed.
      //
      // The dependency fields are `null`, not `false`: the backends may be
      // perfectly healthy, and claiming "database: false" would send whoever
      // reads the alert off chasing Postgres.
      onEvaluationError(error, c);
      const response: PublicReadinessResponse = {
          ready: false,
          db: null,
          redis: null,
          workers: null,
          checkedAt: new Date().toISOString(),
          consumerSummary: null,
          error: 'readiness evaluation failed'
      };
      return c.json(response, 503);
    }

    const response: PublicReadinessResponse = {
      ready: snapshot.ready,
      db: snapshot.db,
      redis: snapshot.redis,
      workers: snapshot.workers,
      checkedAt: snapshot.checkedAt,
      consumerSummary: summarizeConsumerReadiness(snapshot.consumers),
    };
    return c.json(response, snapshot.ready ? 200 : 503);
  };
}
