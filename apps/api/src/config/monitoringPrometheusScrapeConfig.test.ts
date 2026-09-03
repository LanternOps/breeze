import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up (same as composeBindMounts.test.ts).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Why this test exists
 * --------------------
 * #4423 gave the worker container its own `/metrics` Prometheus target on
 * port 3001 (docs/deploy/worker-split.md), but nothing scraped it: the
 * checked-in monitoring stack (`monitoring/prometheus.yml`, brought up by
 * `docker-compose.monitoring.yml`) only had a `breeze-api` job. Series from
 * the worker container — the one running the heavy scheduled jobs — never
 * reached Prometheus, and no alert could fire on worker pool exhaustion or
 * event-loop lag there (#4523).
 *
 * This guards the fix mechanically so the scrape job can't silently regress
 * (e.g. a future prometheus.yml edit that drops or misconfigures it) the way
 * the cascade-registration lists do for RLS — parsing the tracked config is
 * cheaper and more reliable than expecting review to notice a missing job.
 */

interface ScrapeConfig {
  job_name: string;
  metrics_path?: string;
  scheme?: string;
  static_configs?: Array<{ targets?: string[] }>;
  authorization?: { type?: string; credentials_file?: string };
}

interface PrometheusConfig {
  scrape_configs?: ScrapeConfig[];
}

function loadPrometheusConfig(): PrometheusConfig {
  const abs = path.join(REPO_ROOT, 'monitoring/prometheus.yml');
  return load(readFileSync(abs, 'utf8')) as PrometheusConfig;
}

describe('monitoring/prometheus.yml worker scrape target (#4523)', () => {
  const config = loadPrometheusConfig();
  const jobs = config.scrape_configs ?? [];

  it('parses and still has the existing breeze-api job (sanity check)', () => {
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.some((j) => j.job_name === 'breeze-api')).toBe(true);
  });

  it('scrapes the worker container on its own job, distinct from breeze-api', () => {
    const workerJob = jobs.find((j) => j.job_name === 'breeze-worker');
    expect(workerJob).toBeDefined();
    expect(workerJob!.job_name).not.toBe('breeze-api');

    const targets = workerJob!.static_configs?.flatMap((sc) => sc.targets ?? []) ?? [];
    expect(targets).toContain('worker:3001');

    // The worker exposes `/metrics` (unauthenticated path shape differs from
    // the api role's `/api/metrics/scrape`) — see worker.ts and
    // docs/deploy/worker-split.md.
    expect(workerJob!.metrics_path).toBe('/metrics');
  });

  it('authenticates the worker scrape with the same bearer token as breeze-api', () => {
    const apiJob = jobs.find((j) => j.job_name === 'breeze-api')!;
    const workerJob = jobs.find((j) => j.job_name === 'breeze-worker')!;

    expect(workerJob.authorization?.type).toBe('Bearer');
    // Same credentials_file as the api job — one METRICS_SCRAPE_TOKEN secret,
    // shared via the `x-api-env` anchor both containers already read from.
    expect(workerJob.authorization?.credentials_file).toBe(apiJob.authorization?.credentials_file);
  });
});
