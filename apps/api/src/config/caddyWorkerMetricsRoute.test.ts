import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Production Prometheus scrapes the api through Caddy at /metrics/scrape. The
 * worker role (BREEZE_ROLE=worker) publishes its own registry on worker:3001
 * at /metrics, behind the same bearer gate, and it is the process that sends
 * customer alert emails. `GET /metrics/worker` exposes that endpoint through
 * Caddy. Caddy evaluates sibling `handle` blocks with named matchers in
 * written order, and `/metrics/worker` also matches `@api`'s `/metrics/*`,
 * so the worker handle must be written before `handle @api` or the api
 * answers it.
 */

// apps/api/src/config -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const caddyfile = readFileSync(path.join(REPO_ROOT, 'docker/Caddyfile.prod'), 'utf8')
  .replace(/#[^\n]*/g, '');

const matchers = [...caddyfile.matchAll(/^\s*(@\w+)\s+path\s+([^\n]+)/gm)];
const handles = [...caddyfile.matchAll(/^\s*handle\s+(@\w+)\s*\{([^{}]*)\}/gm)];
// `handle @api` holds nested blocks (map, reverse_proxy), so locate it by its
// opening line rather than with the flat-block pattern above.
const apiHandleIndex = caddyfile.search(/^\s*handle\s+@api\s*\{/m);

const workerMatcher = matchers.find((m) => m[2]!.trim().split(/\s+/).join(' ') === '/metrics/worker');
const workerHandle = workerMatcher && handles.find((h) => h[1] === workerMatcher[1]);

describe('Caddy worker metrics route', () => {
  it('finds handle @api, which still owns /metrics/* (so /metrics/scrape is unchanged)', () => {
    expect(apiHandleIndex).toBeGreaterThanOrEqual(0);
    const apiPaths = matchers.find((m) => m[1] === '@api')![2]!.trim().split(/\s+/);
    expect(apiPaths).toContain('/metrics/*');
  });

  it('has a named matcher for exactly /metrics/worker with its own handle', () => {
    expect(workerMatcher, 'expected `@<name> path /metrics/worker`').toBeDefined();
    expect(workerHandle, `expected \`handle ${workerMatcher?.[1]} { ... }\``).toBeDefined();
  });

  it('rewrites the path to /metrics and proxies to worker:3001', () => {
    const body = workerHandle?.[2] ?? '';
    expect(body).toMatch(/^\s*rewrite\s+\*\s+\/metrics\s*$/m);
    expect(body).toMatch(/^\s*reverse_proxy\s+worker:3001\s*$/m);
  });

  it('passes the Authorization header through untouched', () => {
    expect(workerHandle?.[2] ?? '').not.toMatch(/header_up|request_header|Authorization/i);
  });

  it('is written before handle @api, so it wins over /metrics/*', () => {
    expect(workerHandle).toBeDefined();
    expect(workerHandle!.index!).toBeLessThan(apiHandleIndex);
  });
});
