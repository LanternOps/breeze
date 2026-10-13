/**
 * W08 — admission route classification completeness contract.
 *
 * Every endpoint on the core agent router must carry an explicit admission
 * class, so a new agent route cannot silently become sheddable (or silently
 * escape shedding). The list is read from the REAL Hono route table, as in
 * routes/agents/parkedRouteClassification.test.ts. HTTP only; the agent WS
 * upgrade is classified by path and pinned below.
 */
import { describe, expect, it } from 'vitest';
import { agentRoutes } from '../../routes/agents';
import {
  AGENT_ROUTE_ADMISSION_CLASSES,
  AGENT_WS_UPGRADE_ROUTE,
  RETRY_AFTER_OVERRIDES,
  classifyAgentRequest,
  retryAfterRange,
} from './agentRouteClasses';

const AGENT_ID = 'a'.repeat(64);
const UUID = '6f1c7a52-8d0e-4b8f-9a55-0f5a3d1c2b7e';
const MOUNT = '/api/v1/agents';
const MIN_ROUTE_COUNT = 64;

const table = [...new Set(agentRoutes.routes.map((route) => `${route.method} ${route.path}`))].sort();
const endpoints = table.filter((key) => !key.startsWith('ALL '));
const idScoped = endpoints.filter((key) => key.slice(key.indexOf(' ') + 1).startsWith('/:id/'));
const outside = endpoints.filter((key) => !idScoped.includes(key));

function materialise(key: string): { method: string; path: string } {
  const method = key.slice(0, key.indexOf(' '));
  const pattern = key.slice(key.indexOf(' ') + 1)
    .replace(':id', AGENT_ID)
    .replace(/:[A-Za-z]+/g, (param) => (param === ':name' || param === ':os' || param === ':arch' || param === ':op' ? 'x' : UUID));
  return { method, path: `${MOUNT}${pattern}` };
}

describe('agent route admission classes', () => {
  it('enumerates the real agent router', () => {
    expect(table.length).toBeGreaterThanOrEqual(MIN_ROUTE_COUNT);
    expect(idScoped).toContain('POST /:id/heartbeat');
  });

  it('classifies every /:id/ endpoint, and nothing that is not registered', () => {
    const unclassified = idScoped.filter((key) => !(key in AGENT_ROUTE_ADMISSION_CLASSES));
    const stale = Object.keys(AGENT_ROUTE_ADMISSION_CLASSES).filter((key) => !idScoped.includes(key));
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  it.each(idScoped)('%s classifies back to itself', (key) => {
    const { method, path } = materialise(key);
    expect(classifyAgentRequest(method, path)).toEqual({
      cls: AGENT_ROUTE_ADMISSION_CLASSES[key],
      key,
      label: `${MOUNT}${key.slice(key.indexOf(' ') + 1)}`,
    });
  });

  it.each(outside)('%s (outside /:id/) is never sheddable', (key) => {
    const { method, path } = materialise(key);
    const classified = classifyAgentRequest(method, path);
    expect(classified === null || classified.cls === 'protected').toBe(true);
  });

  it('never sheds heartbeats, recovery traffic or loss-sensitive uploads', () => {
    for (const key of [
      'POST /:id/heartbeat', 'GET /:id/commands', 'POST /:id/commands/:commandId/result',
      'POST /:id/rotate-token', 'POST /:id/rotate-token/confirm', 'POST /:id/uninstall-intent',
      'PUT /:id/eventlogs', 'POST /:id/elevation-requests',
    ]) {
      expect(AGENT_ROUTE_ADMISSION_CLASSES[key], key).toBe('protected');
    }
  });

  it('sheds inventory and collector uploads first', () => {
    for (const key of [
      'PUT /:id/hardware', 'PUT /:id/software', 'PUT /:id/disks', 'PUT /:id/network',
      'POST /:id/process-sample', 'POST /:id/logs', 'GET /:id/unifi-collectors',
    ]) {
      expect(AGENT_ROUTE_ADMISSION_CLASSES[key], key).toBe('bulk');
    }
  });

  it('keeps the log shipper Retry-After short: it sleeps without a context and Stop() waits on it', () => {
    // agent/internal/logging/shipper.go:571-575 + 188-193: two uncancellable
    // sleeps of Retry-After block shutdown. 4 s caps that at ~10 s.
    expect(RETRY_AFTER_OVERRIDES['POST /:id/logs']![1]).toBeLessThanOrEqual(4);
    expect(retryAfterRange(classifyAgentRequest('POST', `${MOUNT}/${AGENT_ID}/logs`)!)).toEqual([2, 4]);
  });

  it('every non-override Retry-After for httputil routes is >= 30 s (one attempt per agent cycle)', () => {
    for (const key of idScoped) {
      const req = classifyAgentRequest(materialise(key).method, materialise(key).path)!;
      if (req.cls === 'protected' || key in RETRY_AFTER_OVERRIDES) continue;
      expect(retryAfterRange(req)[0], key).toBeGreaterThanOrEqual(30);
    }
  });

  it('classifies the agent WS upgrade and nothing that merely resembles it', () => {
    expect(classifyAgentRequest('GET', `/api/v1/agent-ws/${AGENT_ID}/ws`)).toEqual({
      cls: 'ws_upgrade', key: 'GET /:id/ws', label: AGENT_WS_UPGRADE_ROUTE,
    });
    expect(classifyAgentRequest('POST', `/api/v1/agent-ws/${AGENT_ID}/ws`)).toBeNull();
    expect(classifyAgentRequest('GET', `/api/v1/agent-ws/${AGENT_ID}/ws/`)).toBeNull();
  });

  it('leaves odd and foreign paths unclassified (admitted; they 404 or route as today)', () => {
    for (const path of [
      `${MOUNT}/${AGENT_ID}/software/`,
      `${MOUNT}//${AGENT_ID}/software`,
      `${MOUNT}/${AGENT_ID}/no-such-action`,
      `/api/v1/ext/acme/agent/${AGENT_ID}/software`,
      `/api/v1/workspace/agent/crawl-config`,
      '/api/v1/devices',
    ]) {
      expect(classifyAgentRequest('PUT', path), path).toBeNull();
    }
  });

  it('labels by template, so attacker-chosen ids cannot mint label values (Review Focus 4)', () => {
    const a = classifyAgentRequest('PUT', `${MOUNT}/${'b'.repeat(64)}/software`);
    const b = classifyAgentRequest('PUT', `${MOUNT}/not-even-hex/software`);
    expect(a?.label).toBe(`${MOUNT}/:id/software`);
    expect(b?.label).toBe(a?.label);
  });
});
