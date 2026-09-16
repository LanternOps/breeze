import '@/lib/i18n';

import { describe, expect, it } from 'vitest';
import { i18n } from '@/lib/i18n';
import {
  formatCollectionSummary,
  formatLastPoll,
  formatReachability,
  resolveAssetTimezone,
} from './reachabilityCopy';
import type { Collection, Reachability } from './types';

const t = ((key: string, options?: Record<string, unknown>) =>
  i18n.t(key, { ns: 'devices', ...options })) as (k: string, o?: Record<string, unknown>) => string;

const TZ = 'UTC';
const now = () => new Date();
const minutesAgo = (n: number) => new Date(now().getTime() - n * 60_000).toISOString();
const hoursAgo = (n: number) => new Date(now().getTime() - n * 3_600_000).toISOString();

describe('formatReachability', () => {
  it('names the state, the source and the age — never a bare state word', () => {
    const r: Reachability = {
      state: 'responding',
      source: 'snmp',
      observedAt: minutesAgo(2),
      lastKnown: null,
      detail: { snmp: { state: 'ok', observedAt: minutesAgo(2), consecutiveFailures: 0 } },
    };
    const copy = formatReachability(r, t, TZ);
    expect(copy.label).toContain('Responding');
    expect(copy.label).toContain('·');
    expect(copy.label).toContain('SNMP');
    expect(copy.label).toMatch(/2\s*min/);
    expect(copy.tone).toBe('success');
    // The absolute title must be a real stamp, not the ISO string echoed back.
    expect(copy.title).not.toBe(r.observedAt);
    expect(copy.title.length).toBeGreaterThan(0);
  });

  it('reads not_responding from the negative host observation', () => {
    const r: Reachability = {
      state: 'not_responding',
      source: 'network_check',
      observedAt: minutesAgo(1),
      lastKnown: null,
      detail: {
        networkCheck: { state: 'offline', observedAt: minutesAgo(1), responseMs: null, monitorId: 'm1' },
      },
    };
    const copy = formatReachability(r, t, TZ);
    expect(copy.label).toContain('Not responding');
    expect(copy.label).toContain('Network check');
    expect(copy.tone).toBe('destructive');
  });

  it('falls back to lastKnown when nothing is inside its freshness window', () => {
    const r: Reachability = {
      state: 'unverified',
      source: null,
      observedAt: null,
      lastKnown: { state: 'responding', source: 'scan', observedAt: hoursAgo(19) },
      detail: {},
    };
    const copy = formatReachability(r, t, TZ);
    expect(copy.label).toContain('Unverified');
    expect(copy.label).toContain('last seen by');
    expect(copy.label).toContain('Scan');
    expect(copy.label).toMatch(/19\s*hr/);
    expect(copy.tone).toBe('muted');
  });

  it('says "never observed" when unverified with no observation at all', () => {
    const r: Reachability = { state: 'unverified', source: null, observedAt: null, lastKnown: null, detail: {} };
    const copy = formatReachability(r, t, TZ);
    expect(copy.label).toContain('Unverified');
    expect(copy.label).toContain('never observed');
    expect(copy.title).toBe('');
  });

  it('degrades to Unverified when the API sent no reachability at all', () => {
    const copy = formatReachability(null, t, TZ);
    expect(copy.label).toContain('Unverified');
    expect(copy.tone).toBe('muted');
    expect(copy.observedAt).toBeNull();
  });
});

describe('formatCollectionSummary', () => {
  const oid = (state: Collection['oids'][number]['state'], name: string) => ({
    baseOid: `1.3.6.1.2.1.${name.length}`,
    name,
    mode: 'walk' as const,
    cadence: 'fast' as const,
    state,
    observedAt: minutesAgo(3),
    instances: [],
    error: null,
  });

  it('counts collecting / unsupported / stale', () => {
    const collection: Collection = {
      templateId: 'tpl-1',
      lastPolledAt: minutesAgo(3),
      pollingInterval: 300,
      status: 'ok',
      consecutiveFailures: 0,
      oids: [oid('collecting', 'a'), oid('collecting', 'bb'), oid('unsupported', 'ccc'), oid('stale', 'dddd')],
    };
    const summary = formatCollectionSummary(collection, t)!;
    expect(summary).toContain('2');
    expect(summary).toContain('collecting');
    expect(summary).toContain('1');
    expect(summary).toContain('unsupported');
    expect(summary).toContain('stale');
  });

  it('returns null when there is no SNMP device to summarise', () => {
    expect(formatCollectionSummary(null, t)).toBeNull();
  });
});

describe('formatLastPoll', () => {
  it('states no_template as a cause, not as a bare failure', () => {
    const collection: Collection = {
      templateId: null,
      lastPolledAt: null,
      pollingInterval: 300,
      status: 'no_template',
      consecutiveFailures: 0,
      oids: [],
    };
    const copy = formatLastPoll(collection, t, TZ);
    expect(copy.label).toContain('No template');
    expect(copy.tone).toBe('destructive');
  });

  it('pairs an OK poll with its age', () => {
    const collection: Collection = {
      templateId: 'tpl-1',
      lastPolledAt: minutesAgo(4),
      pollingInterval: 300,
      status: 'ok',
      consecutiveFailures: 0,
      oids: [],
    };
    const copy = formatLastPoll(collection, t, TZ);
    expect(copy.label).toMatch(/4\s*min/);
    expect(copy.tone).toBe('success');
  });
});

describe('resolveAssetTimezone', () => {
  it('prefers the site zone', () => {
    expect(resolveAssetTimezone('America/Chicago')).toBe('America/Chicago');
  });

  it('falls back to the browser zone when the asset has no site', () => {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveAssetTimezone(null)).toBe(browserZone);
    expect(resolveAssetTimezone('')).toBe(browserZone);
  });
});
