/**
 * POST /discovery/assets/:id/probe — the "Check now" button (spec §5, D2).
 *
 * Its own module rather than a 27th route in routes/discovery.ts (2,247 lines).
 * Mounted as a second sub-router at /discovery in index.ts.
 *
 * Shape, in order:
 *   1. resolve + LOCK the asset (site-locking resolver, shared with monitoring)
 *   2. require ip_address and site_id
 *   3. refuse a second in-flight probe (409 PROBE_IN_FLIGHT)
 *   4. pick a site-strict executor (409 NO_AGENT_IN_SITE)
 *   5. stamp pending + last_probe_ref, THEN dispatch — never the other way
 *      round, or a fast agent's result arrives before the row it must match
 *   6. wait up to 8 s, then answer 200 or 202
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { resolveAssetForMutation, type AssetAuthContext } from '../services/assetAccessScope';
import { loadAssetSiteId, selectNetworkExecutor } from '../services/networkExecutorSelection';
import { dispatchCommandToAgent } from '../services/agentCommandRelay';
import {
  applyProbeResult,
  awaitProbeResult,
  buildProbeCommandId,
  PROBE_IN_FLIGHT_MS,
  PROBE_WAIT_MS,
} from '../services/assetProbe';
import { deriveReachability } from '../services/assetReachability';
import { loadReachabilityInputs } from '../services/assetReachabilityLoader';

export const discoveryAssetProbeRoutes = new Hono();
discoveryAssetProbeRoutes.use('*', authMiddleware);

const requireDiscoveryWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);

async function reachabilityFor(assetId: string) {
  const input = (await loadReachabilityInputs([assetId])).get(assetId);
  return input ? deriveReachability(input) : null;
}

discoveryAssetProbeRoutes.post(
  '/assets/:id/probe',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as AssetAuthContext;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const assetId = c.req.param('id')!;

    // 1. Resolve and lock. The ambient request transaction holds the row lock
    //    through the pending stamp below, so two concurrent "Check now" clicks
    //    cannot both pass the in-flight guard.
    const resolved = await resolveAssetForMutation(auth, perms, assetId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const asset = resolved.asset;

    // 2. A probe needs somewhere to send a ping from and somewhere to send it to.
    if (!asset.ipAddress) {
      return c.json({ error: 'This asset has no IP address to probe', code: 'ASSET_NO_IP' }, 422);
    }
    const siteId = await loadAssetSiteId(asset.orgId, asset.id);
    if (!siteId) {
      return c.json({ error: 'This asset has no site, so no agent can be chosen to probe it', code: 'ASSET_NO_SITE' }, 422);
    }

    // 3. One in-flight probe per asset (spec §5 rate limit). A stale pending is
    //    not in flight — deriveReachability already reads it as failed.
    if (
      asset.lastProbeStatus === 'pending'
      && asset.lastProbeAt
      && Date.now() - new Date(asset.lastProbeAt).getTime() < PROBE_IN_FLIGHT_MS
    ) {
      return c.json({ error: 'A probe is already running for this asset', code: 'PROBE_IN_FLIGHT' }, 409);
    }

    // 4. Site-strict executor. No org-wide fallback for asset-bound work.
    const pick = await selectNetworkExecutor({ orgId: asset.orgId, siteId });
    if ('error' in pick) {
      return c.json({ error: 'No online agent in this asset’s site', code: 'NO_AGENT_IN_SITE' }, 409);
    }

    // 5. Stamp BEFORE dispatch. A local switch can answer in single-digit
    //    milliseconds; if the stamp landed after the send, applyProbeResult's
    //    CAS would find no pending row and drop a perfectly good result.
    const commandId = buildProbeCommandId(asset.id);
    const startedAt = new Date();
    await db
      .update(discoveredAssets)
      .set({
        lastProbeAt: startedAt,
        lastProbeStatus: 'pending',
        lastProbeRef: commandId,
        lastProbeResponseMs: null,
        updatedAt: startedAt,
      })
      .where(and(eq(discoveredAssets.id, asset.id), eq(discoveredAssets.orgId, asset.orgId)));

    writeRouteAudit(c, {
      orgId: asset.orgId,
      action: 'discovery.asset.probe',
      resourceType: 'discovered_asset',
      resourceId: asset.id,
      resourceName: asset.label ?? asset.hostname ?? String(asset.ipAddress),
      details: { agentId: pick.agentId, commandId },
    });

    const waiting = awaitProbeResult(commandId, PROBE_WAIT_MS);
    const outcome = await dispatchCommandToAgent(
      pick.agentId,
      {
        id: commandId,
        type: 'network_ping',
        payload: {
          target: String(asset.ipAddress),
          timeout: 5,
          count: 3,
          // Read back by recordOrphanedResultExpectation on the instance that
          // owns the agent socket (spec §5 correlation). The agent ignores both.
          probeAssetId: asset.id,
          probeSiteId: siteId,
        },
      },
      { priority: 'probe' },
    );

    if (outcome.status !== 'sent') {
      // The agent went away between the pick and the send. Close the probe out
      // now rather than leaving a pending stamp to time out in two minutes.
      //
      // `outcome.message` is the ONLY place the real cause exists: relay seal
      // and enqueue failures put `relay … failed: <err>` there, and
      // services/agentCommandRelay.ts logs nothing of its own. Dropping it
      // would lose the diagnosis entirely — not in the response, not in the
      // logs, not in Sentry.
      const dispatchError = 'message' in outcome && outcome.message
        ? `dispatch ${outcome.status}: ${outcome.message}`
        : `dispatch ${outcome.status}`;
      console.warn(`[AssetProbe] Dispatch of ${commandId} to agent ${pick.agentId} did not send: ${dispatchError}`);

      const applied = await applyProbeResult({
        commandId,
        assetId: asset.id,
        expectedIp: String(asset.ipAddress),
        expectedSiteId: siteId,
        status: 'failed',
        responseMs: null,
        error: dispatchError,
      });
      // `indeterminate` says nothing about execution — the frame may have gone
      // out anyway, and the genuine result may already have landed on the WS
      // path and cleared the pending stamp. When the CAS finds no row, our
      // locally-assumed 'failed' is NOT the truth: report the derived state
      // instead of a response body that contradicts its own reachability
      // block.
      const reachability = await reachabilityFor(asset.id);
      if (!applied) {
        console.warn(
          `[AssetProbe] Dispatch-failure stamp for ${commandId} did not correlate `
          + '(a real result landed first, or the asset moved); reporting the derived state instead.'
        );
      }
      return c.json({
        probe: applied
          ? { state: 'failed', responseMs: null, observedAt: startedAt.toISOString(), agentId: pick.agentId, error: dispatchError }
          : { state: 'pending', responseMs: null, observedAt: startedAt.toISOString(), agentId: pick.agentId, error: dispatchError },
        reachability,
      }, applied ? 200 : 202);
    }

    const result = await waiting;
    if (!result) {
      // Spec §5.4 — the late result is written by the agentWs handler; the page
      // re-fetches the asset every 3 s for up to 60 s while pending.
      return c.json({
        probe: { state: 'pending', responseMs: null, observedAt: startedAt.toISOString(), agentId: pick.agentId },
        reachability: await reachabilityFor(asset.id),
      }, 202);
    }

    return c.json({
      probe: {
        state: result.status,
        responseMs: result.responseMs,
        observedAt: startedAt.toISOString(),
        agentId: pick.agentId,
        error: result.error,
      },
      reachability: await reachabilityFor(asset.id),
    }, 200);
  },
);
