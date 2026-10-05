/**
 * CONTRACT TEST — every Workspace write route runs behind `adminGate`, the
 * gate that checks the caller's Workspace permission grants and MFA, unless it
 * is listed below with the reason it uses a different credential.
 *
 * Mirrors apps/api's `writeRoutePermissionGate.contract.test.ts` for the
 * extension's routers, which the host mounts outside index.ts. Each router is
 * built with inert deps (registration never calls them) and Hono's own router
 * resolves the handler chain a request to each write endpoint actually runs.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { adminGate } from './adminGate';
import { createAgentRoutes } from './agent';
import { createClientRoutes } from './client';
import { createContentRoutes } from './content';
import { createDashboardRoutes } from './dashboard';
import { createDeviceSummaryRoutes } from './deviceSummary';
import { createHelperRoutes } from './helper';
import { createSourcesRoutes } from './sources';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SAMPLE = '11111111-1111-4111-8111-111111111111';

/** `<router> METHOD path` → why it is not behind adminGate. */
const WRITE_ROUTES_WITHOUT_ADMIN_GATE: Record<string, string> = {
  // agent.ts — authenticated by the device agent credential (host agent auth).
  'agent POST /sources/:id/credential': 'agent fetches its own crawl credential; agent identity required',
  'agent POST /runs': 'agent reports a crawl run it was assigned; agent identity required',
  'agent POST /runs/:runId/batch': 'agent uploads crawl results for its own run',
  'agent POST /runs/:runId/complete': 'agent closes its own crawl run',
  'agent POST /sources/:id/events': 'agent reports change events for a source assigned to it',
  // helper.ts — authenticated by the end-user helper device credential.
  'helper POST /filing/classify': 'helper device credential; classifies the signed-in user\'s own mail',
  'helper POST /filing/:fileIndexId/assign': 'helper device credential; files the user\'s own mail',
  'helper POST /activity': 'helper device credential; records the user\'s own activity',
  // client.ts — clientGate: organization-scoped end user acting on their own mail.
  'client POST /filing/:fileIndexId/assign': 'end-user add-in; clientGate pins the caller\'s own org and attributes the action',
};

// Registration never invokes deps; any property read returns an inert function.
const inertDeps = new Proxy({}, { get: () => () => undefined }) as never;

const routers: Record<string, Hono> = {
  agent: createAgentRoutes(inertDeps) as unknown as Hono,
  client: createClientRoutes(inertDeps) as unknown as Hono,
  content: createContentRoutes(inertDeps) as unknown as Hono,
  dashboard: createDashboardRoutes(inertDeps) as unknown as Hono,
  deviceSummary: createDeviceSummaryRoutes(inertDeps) as unknown as Hono,
  helper: createHelperRoutes(inertDeps) as unknown as Hono,
  sources: createSourcesRoutes(inertDeps) as unknown as Hono,
};

type RouterRoute = Hono['routes'][number];
type MatchEntry = [[RouterRoute['handler'], RouterRoute], unknown];

function ungatedWriteRoutes(): string[] {
  const found: string[] = [];
  for (const [name, router] of Object.entries(routers)) {
    // `.post(path, a, handler)` registers one consecutive entry per handler.
    const registrations: Array<{ key: string; entries: Set<RouterRoute>; last: RouterRoute }> = [];
    router.routes.forEach((route, i) => {
      if (!WRITE_METHODS.has(route.method)) return;
      const previous = router.routes[i - 1];
      const current = registrations.at(-1);
      if (current && previous === current.last && previous.method === route.method && previous.path === route.path) {
        current.entries.add(route);
        current.last = route;
      } else {
        registrations.push({ key: `${route.method} ${route.path}`, entries: new Set([route]), last: route });
      }
    });
    const keys = registrations.map((r) => r.key);
    expect(new Set(keys).size, `${name}: duplicate write registration`).toBe(keys.length);
    for (const { key, entries, last: endpoint } of registrations) {
      const path = endpoint.path.replace(/:[A-Za-z_]\w*(?:\{[^}]*\})?\??/g, SAMPLE).replace(/\*/g, 'probe');
      const [matches] = router.router.match(endpoint.method, path) as unknown as [MatchEntry[]];
      const index = matches.findIndex(([[, route]]) => route === endpoint);
      expect(index, `${name} ${key}: could not resolve its handler chain`).toBeGreaterThanOrEqual(0);
      // Middleware (ALL entries) plus this registration's own handlers only.
      const chain = matches
        .slice(0, index + 1)
        .filter(([[, route]]) => route.method === 'ALL' || entries.has(route))
        .map(([[handler]]) => handler);
      if (!chain.includes(adminGate as never)) found.push(`${name} ${key}`);
    }
  }
  return found.sort();
}

describe('workspace write route gate contract', () => {
  const ungated = ungatedWriteRoutes();

  it('runs every write route behind adminGate or a reviewed exemption', () => {
    const unexpected = ungated.filter((key) => !Object.hasOwn(WRITE_ROUTES_WITHOUT_ADMIN_GATE, key));
    expect(unexpected, 'add adminGate, or an exemption with a reason').toEqual([]);
  });

  it('keeps the exemption list current', () => {
    const stale = Object.keys(WRITE_ROUTES_WITHOUT_ADMIN_GATE).filter((key) => !ungated.includes(key));
    expect(stale, 'remove exemptions for routes that are now gated or gone').toEqual([]);
    for (const [key, reason] of Object.entries(WRITE_ROUTES_WITHOUT_ADMIN_GATE)) {
      expect(reason.trim().length, key).toBeGreaterThan(0);
    }
  });

  it('sees the gated routers', () => {
    // Guards against a vacuous pass if route discovery breaks.
    const writes = Object.values(routers).flatMap((r) => r.routes.filter((x) => WRITE_METHODS.has(x.method)));
    expect(writes.length).toBeGreaterThan(15);
  });
});
