import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('production readiness wiring', () => {
  it.each([
    ['docker-compose.yml', '40s'],
    ['docker-compose.override.yml.dev', '60s'],
    ['deploy/docker-compose.prod.yml', '40s'],
  ])('%s admits API traffic through /ready after its start period', (path, startPeriod) => {
    const document = load(read(path)) as {
      services: { api: { healthcheck: { test: string[]; start_period: string } } };
    };
    const healthcheck = document.services.api.healthcheck;

    expect(healthcheck.test.join(' ')).toContain('http://127.0.0.1:3001/ready');
    expect(healthcheck.start_period).toBe(startPeriod);
  });

  it('uses readiness, not liveness, for the post-deploy admission gate', () => {
    const deploy = read('scripts/prod/deploy.sh');
    expect(deploy).toContain('https://${BREEZE_DOMAIN}/ready');
    expect(deploy).not.toMatch(/curl[^\n]+https:\/\/\$\{BREEZE_DOMAIN\}\/health/);
  });

  it('keeps both liveness routes mounted independently of readiness', () => {
    const index = read('apps/api/src/index.ts');
    expect(index).toContain("app.get('/health',");
    expect(index).toContain("app.get('/health/live',");
  });

  it('invalidates the single readiness evaluator on registry transitions', () => {
    const index = read('apps/api/src/index.ts');
    expect(index).toContain('setWorkerReadinessTransitionHandler(() => readiness.invalidate())');
  });
});
