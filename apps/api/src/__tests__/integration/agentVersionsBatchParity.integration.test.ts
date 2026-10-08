/**
 * #8053 W1a-1 — the heartbeat's single agent_versions read returns exactly
 * what three resolvePinnedUpgradeTarget calls return (#3499 lockstep: same
 * predicates, same created_at DESC tiebreak), against real PostgreSQL.
 */
import './setup';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { agentVersions } from '../../db/schema';
import { getBinaryEdition } from '../../services/binaryEdition';
import { resolvePinnedUpgradeTarget, resolvePinnedUpgradeTargets } from '../../routes/agents/helpers';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function row(platform: string, component: string, version: string, opts: { isLatest?: boolean; edition?: string; createdAt?: Date } = {}) {
  await withSystemDbAccessContext(() => db.insert(agentVersions).values({
    platform, architecture: 'amd64', component, version,
    downloadUrl: `https://example.invalid/${component}/${version}`, checksum: 'c'.repeat(64),
    isLatest: opts.isLatest ?? false, edition: opts.edition ?? getBinaryEdition(),
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  }));
}

const otherEdition = () => (getBinaryEdition() === 'hosted' ? 'self-host' : 'hosted');

describe('resolvePinnedUpgradeTargets (#8053 W1a-1) — real PostgreSQL', () => {
  const cases: Array<[string, Array<{ component: string; pin: string | null }>, (platform: string) => Promise<void>]> = [
    ['no rows at all', [{ component: 'agent', pin: null }, { component: 'helper', pin: null }, { component: 'watchdog', pin: null }], async () => {}],
    ['latest per component, newest created_at wins among duplicate is_latest rows', [
      { component: 'agent', pin: null }, { component: 'helper', pin: null }, { component: 'watchdog', pin: null },
    ], async (p) => {
      await row(p, 'agent', '1.0.0', { isLatest: true, createdAt: new Date('2026-01-01T00:00:00Z') });
      await row(p, 'agent', '1.1.0', { isLatest: true, createdAt: new Date('2026-02-01T00:00:00Z') });
      await row(p, 'helper', '2.0.0', { isLatest: true });
      await row(p, 'watchdog', '3.0.0', { isLatest: false });
    }],
    ['a pin that exists (not latest) and a pin with no build', [
      { component: 'agent', pin: '1.0.0' }, { component: 'helper', pin: null }, { component: 'watchdog', pin: '9.9.9' },
    ], async (p) => {
      await row(p, 'agent', '1.0.0');
      await row(p, 'agent', '1.1.0', { isLatest: true });
      await row(p, 'helper', '2.0.0', { isLatest: true });
      await row(p, 'watchdog', '3.0.0', { isLatest: true });
    }],
    ['rows of the other edition never count', [
      { component: 'agent', pin: null }, { component: 'watchdog', pin: '3.1.0' },
    ], async (p) => {
      await row(p, 'agent', '1.2.0', { isLatest: true, edition: otherEdition() });
      await row(p, 'watchdog', '3.1.0', { edition: otherEdition() });
    }],
    ['a pinned (older, non-latest) version wins over a newer is_latest row of the same component', [
      { component: 'agent', pin: '1.5.0' }, { component: 'watchdog', pin: '3.5.0' },
    ], async (p) => {
      await row(p, 'agent', '1.5.0', { createdAt: new Date('2026-03-01T00:00:00Z') });
      await row(p, 'agent', '1.9.0', { isLatest: true, createdAt: new Date('2026-04-01T00:00:00Z') });
      await row(p, 'watchdog', '3.5.0', { createdAt: new Date('2026-03-01T00:00:00Z') });
      await row(p, 'watchdog', '3.9.0', { isLatest: true, createdAt: new Date('2026-04-01T00:00:00Z') });
    }],
  ];

  for (const [name, requests, arrange] of cases) {
    runDb(`matches three single reads: ${name}`, async () => {
      const platform = `par-${randomBytes(4).toString('hex')}`;
      await arrange(platform);
      const batch = await withSystemDbAccessContext(() =>
        resolvePinnedUpgradeTargets({ platform, architecture: 'amd64', requests, agentId: 'parity' }));
      for (const request of requests) {
        const single = await withSystemDbAccessContext(() =>
          resolvePinnedUpgradeTarget({ ...request, platform, architecture: 'amd64', agentId: 'parity' }));
        expect(batch.get(request.component), `${request.component} pin=${request.pin}`).toBe(single);
      }
    });
  }
});
