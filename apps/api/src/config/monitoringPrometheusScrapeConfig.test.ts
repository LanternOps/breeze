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
  relabel_configs?: Array<{ source_labels?: string[]; target_label?: string }>;
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
    // Exactly one — a duplicate job_name (e.g. from a bad merge) would have
    // Prometheus scrape the same target twice under identical labels, which
    // silently double-counts the worker's series the same way an unfiltered
    // dashboard would double-count across roles.
    expect(jobs.filter((j) => j.job_name === 'breeze-worker')).toHaveLength(1);

    const workerJob = jobs.find((j) => j.job_name === 'breeze-worker');
    expect(workerJob).toBeDefined();
    expect(workerJob!.job_name).not.toBe('breeze-api');

    const targets = workerJob!.static_configs?.flatMap((sc) => sc.targets ?? []) ?? [];
    expect(targets).toContain('worker:3001');

    // The worker's Bearer-authenticated scrape endpoint is `/metrics` — a
    // different path shape than the api role's `/api/metrics/scrape` — see
    // worker.ts and docs/deploy/worker-split.md.
    expect(workerJob!.metrics_path).toBe('/metrics');

    // Same instance-relabel rule as breeze-api, so `instance` carries the
    // bare hostname (not `worker:3001`) and dashboard/alert queries that
    // join on `instance` across both jobs still line up.
    expect(workerJob!.relabel_configs?.[0]?.target_label).toBe('instance');
  });

  it('authenticates the worker scrape with the same bearer token as breeze-api', () => {
    const apiJob = jobs.find((j) => j.job_name === 'breeze-api')!;
    const workerJob = jobs.find((j) => j.job_name === 'breeze-worker')!;

    expect(workerJob.authorization?.type).toBe('Bearer');
    // Same credentials_file as the api job — both point at the one
    // `metrics_scrape_token` Docker secret declared in
    // docker-compose.monitoring.yml (mounted into the prometheus container at
    // /run/secrets/...), not the api/worker containers' own METRICS_SCRAPE_TOKEN
    // env var (that one is what the *servers* check against; this is what
    // Prometheus itself presents as the scraper).
    expect(workerJob.authorization?.credentials_file).toBe(apiJob.authorization?.credentials_file);
  });
});
