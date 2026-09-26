import './setup';
import { describe, expect, it } from 'vitest';
import { CommandTypes } from '../../services/commandTypes';
import {
  COMMAND_OFFLINE_POLICY_REGISTRY,
  EXPLICITLY_CLASSIFIED_COMMAND_TYPES,
  defaultOfflinePolicy,
} from '../../services/commandOfflinePolicy';
import { getCommandTimeoutMs } from '../../services/commandTimeouts';
import {
  hasSensitivePayload,
  TERMINAL_PAYLOAD_STRIP_KEYS,
} from '../../services/sensitiveCommandPayload';
import { seedTopologyCommandFixture } from '../helpers/topologyM1';

describe('topology diagnostic command authority', () => {
  it.each(['http', 'websocket'] as const)(
    'rejects stale diagnostic authority on %s',
    async (transport) => {
      const f = await seedTopologyCommandFixture();
      await f.moveOriginToOtherSite();
      // The inventory-move fence terminalises the row first; the application
      // layer must independently refuse the same row if it is ever pending
      // again (a raced move, a replayed enqueue).
      expect(await f.claimThrough(transport)).toMatchObject({ delivered: false });
      await f.reopenCommand();
      expect(await f.claimThrough(transport)).toMatchObject({
        delivered: false,
        reason: 'scope_changed',
      });
      expect(await f.resultFromOtherAgent()).toMatchObject({ accepted: false });
    },
  );

  it.each(['http', 'websocket'] as const)(
    'delivers exactly once while every pinned fact still holds on %s',
    async (transport) => {
      const f = await seedTopologyCommandFixture();
      expect(await f.claimThrough(transport)).toMatchObject({
        delivered: true,
        status: 'sent',
      });
      // A second claim finds nothing: the row is no longer `pending`.
      expect((await f.claimThrough(transport)).delivered).toBe(false);
    },
  );

  it.each(['http', 'websocket'] as const)(
    'refuses a revoked collection source on %s',
    async (transport) => {
      const f = await seedTopologyCommandFixture();
      await f.revokeOriginSource();
      expect(await f.claimThrough(transport)).toMatchObject({
        delivered: false,
        status: 'cancelled',
        reason: 'scope_changed',
      });
    },
  );

  // M3-D7: an unrelated settings write no longer fences every in-flight plan;
  // only a change to what THIS plan executes does.
  it.each(['http', 'websocket'] as const)(
    'delivers across an unrelated site configuration change on %s',
    async (transport) => {
      const f = await seedTopologyCommandFixture({ withTarget: true });
      await f.changeSiteConfiguration();
      expect(await f.claimThrough(transport)).toMatchObject({ delivered: true, status: 'sent' });
    },
  );

  it.each(['http', 'websocket'] as const)(
    'refuses a plan whose pinned target changed on %s',
    async (transport) => {
      const f = await seedTopologyCommandFixture({ withTarget: true });
      await f.changeTarget();
      expect(await f.claimThrough(transport)).toMatchObject({
        delivered: false,
        reason: 'scope_changed',
      });
    },
  );

  it.each(['http', 'websocket'] as const)(
    'refuses an outbound plan once outbound probing is disabled on %s',
    async (transport) => {
      const f = await seedTopologyCommandFixture({ withTarget: true });
      await f.disableOutbound();
      expect(await f.claimThrough(transport)).toMatchObject({
        delivered: false,
        reason: 'scope_changed',
      });
    },
  );

  it.each(['http', 'websocket'] as const)(
    'expires an accepted-but-undelivered plan rather than re-clocking it on %s',
    async (transport) => {
      const f = await seedTopologyCommandFixture({
        acceptedAt: new Date(Date.now() - 10 * 60 * 1000),
      });
      expect(await f.claimThrough(transport)).toMatchObject({
        delivered: false,
        status: 'cancelled',
        reason: 'expired',
      });
    },
  );

  it.each(['http', 'websocket'] as const)(
    'fails closed on a command whose parent run does not exist on %s',
    async (transport) => {
      const f = await seedTopologyCommandFixture({ orphanRun: true });
      expect(await f.claimThrough(transport)).toMatchObject({
        delivered: false,
        status: 'cancelled',
        reason: 'scope_changed',
      });
    },
  );

  it('binds a result to the run, attempt, command and digest the server pinned', async () => {
    const f = await seedTopologyCommandFixture();
    const step = {
      id: f.plan.steps[0]!.id,
      state: 'succeeded' as const,
      reason: null,
      attribution: {
        originDeviceId: f.deviceId,
        originAgentId: f.deviceId,
        requestedMethod: 'icmp' as const,
        actualMethod: 'icmp' as const,
        destinationId: f.plan.destinations[0]!.id,
        resolvedIp: '192.0.2.1',
        family: 'ipv4' as const,
        port: null,
        interfaceId: null,
        localAddress: null,
        contextKey: 'default',
        tableKey: null,
        nextHop: '192.0.2.1',
        proxyUsed: null,
        quality: 'observed' as const,
        routeChanged: false,
        evidenceRefs: [],
      },
      startedAt: null,
      finishedAt: null,
      receivedAt: null,
      truncated: false,
      details: { packetsSent: 3, packetsReceived: 3 },
    };
    const good = {
      version: 1,
      runId: f.runId,
      attemptId: f.attemptId,
      commandId: f.commandId,
      planDigest: f.plan.digest,
      steps: [step],
      truncated: false,
    };
    expect(f.acceptResult(good)).toMatchObject({ accepted: true });
    expect(f.acceptResult({ ...good, runId: crypto.randomUUID() })).toMatchObject({
      accepted: false,
    });
    expect(f.acceptResult({ ...good, planDigest: 'f'.repeat(64) })).toMatchObject({
      accepted: false,
    });
    expect(f.acceptResult({ ...good, steps: [{ ...step, id: 'not-a-uuid' }] })).toMatchObject({
      accepted: false,
    });
  });

  it('classifies the command in every closed registry with no-offline semantics', () => {
    const type = CommandTypes.NETWORK_DIAGNOSTIC;
    expect(type).toBe('network_diagnostic');
    expect(COMMAND_OFFLINE_POLICY_REGISTRY[type]).toBe('live');
    expect(EXPLICITLY_CLASSIFIED_COMMAND_TYPES.has(type)).toBe(true);
    expect(defaultOfflinePolicy(type)).toEqual({ kind: 'reject' });
    // Strictly under the plan's own 120s lifetime ceiling plus delivery grace.
    expect(getCommandTimeoutMs(type)).toBeLessThanOrEqual(150_000);
    // The plan carries no credential material, and terminal payload erasure
    // must leave the run/attempt/command audit identity behind.
    expect(hasSensitivePayload(type)).toBe(false);
    for (const key of ['runId', 'attemptId', 'commandId', 'planDigest']) {
      expect(TERMINAL_PAYLOAD_STRIP_KEYS).not.toContain(key);
    }
  });
});
