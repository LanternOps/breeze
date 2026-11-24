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
import { resolvePinnedUpgradeTarget, resolvePinnedUpgradeTargets, type UpgradeOsHold } from '../../routes/agents/helpers';
import type { DeviceOsFacts } from '../../services/agentOsFloor';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function row(
  platform: string,
  component: string,
  version: string,
  opts: { isLatest?: boolean; edition?: string; createdAt?: Date; minOsVersion?: string } = {},
) {
  await withSystemDbAccessContext(() => db.insert(agentVersions).values({
    platform, architecture: 'amd64', component, version,
    downloadUrl: `https://example.invalid/${component}/${version}`, checksum: 'c'.repeat(64),
    isLatest: opts.isLatest ?? false, edition: opts.edition ?? getBinaryEdition(),
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.minOsVersion ? { minOsVersion: opts.minOsVersion } : {}),
  }));
}

// #12169: the device OS is independent of the random query platform, so a Mac
// below / above a floor can be judged against these synthetic rows.
const MAC_12: DeviceOsFacts = { platform: 'macos', reportedOsVersion: 'darwin 12.7.6', storedOsVersion: null };
const MAC_15: DeviceOsFacts = { platform: 'macos', reportedOsVersion: 'darwin 15.8.1', storedOsVersion: null };

const otherEdition = () => (getBinaryEdition() === 'hosted' ? 'self-host' : 'hosted');

describe('resolvePinnedUpgradeTargets (#8053 W1a-1) — real PostgreSQL', () => {
  const cases: Array<[
    string,
    Array<{ component: string; pin: string | null }>,
    (platform: string) => Promise<void>,
    DeviceOsFacts?,
  ]> = [
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
    ['#12169 a macOS 12 device under a 13.0 floor: latest and pinned both held, a floorless row offered', [
      { component: 'agent', pin: null }, { component: 'helper', pin: null }, { component: 'watchdog', pin: '3.5.0' },
    ], async (p) => {
      await row(p, 'agent', '1.9.0', { isLatest: true, minOsVersion: '13.0' });
      await row(p, 'helper', '2.0.0', { isLatest: true });
      await row(p, 'watchdog', '3.5.0', { minOsVersion: '13.0' });
    }, MAC_12],
    ['#12169 a macOS 15 device under a 13.0 floor is offered everything', [
      { component: 'agent', pin: null }, { component: 'watchdog', pin: '3.5.0' },
    ], async (p) => {
      await row(p, 'agent', '1.9.0', { isLatest: true, minOsVersion: '13.0' });
      await row(p, 'watchdog', '3.5.0', { minOsVersion: '13.0' });
    }, MAC_15],
  ];

  // No floor rows in the pre-#12169 cases, so any device OS allows; a Linux
  // device keeps them identical to before the gate existed.
  const LINUX: DeviceOsFacts = { platform: 'linux', reportedOsVersion: null, storedOsVersion: null };

  for (const [name, requests, arrange, deviceOs = LINUX] of cases) {
    runDb(`matches three single reads: ${name}`, async () => {
      const platform = `par-${randomBytes(4).toString('hex')}`;
      await arrange(platform);
      const batchHolds: UpgradeOsHold[] = [];
      const batch = await withSystemDbAccessContext(() =>
        resolvePinnedUpgradeTargets({
          platform, architecture: 'amd64', requests, agentId: 'parity', deviceOs, onOsHold: (h) => batchHolds.push(h),
        }));
      const singleHolds: UpgradeOsHold[] = [];
      for (const request of requests) {
        const single = await withSystemDbAccessContext(() =>
          resolvePinnedUpgradeTarget({
            ...request, platform, architecture: 'amd64', agentId: 'parity', deviceOs, onOsHold: (h) => singleHolds.push(h),
          }));
        expect(batch.get(request.component), `${request.component} pin=${request.pin}`).toBe(single);
      }
      expect(batchHolds).toEqual(singleHolds);
      if (deviceOs === MAC_12) {
        expect(batch.get('agent')).toBeNull();
        expect(batch.get('watchdog')).toBeNull();
        expect(batch.get('helper')).toBe('2.0.0');
        expect(batchHolds.map((h) => [h.component, h.blockedVersion, h.reason, h.reportedOs])).toEqual([
          ['agent', '1.9.0', 'os_below_minimum', '12.7.6'],
          ['watchdog', '3.5.0', 'os_below_minimum', '12.7.6'],
        ]);
      }
      if (deviceOs === MAC_15) {
        expect(batch.get('agent')).toBe('1.9.0');
        expect(batch.get('watchdog')).toBe('3.5.0');
        expect(batchHolds).toEqual([]);
      }
    });
  }
});
