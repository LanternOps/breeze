/**
 * `probe_network_asset` (full-control W09, #6779): the AI twin of
 * POST /discovery/assets/:id/probe — the "Check now" button.
 *
 * Tier 2. A probe dispatches ONE `network_ping` from an online agent in the
 * asset's own site (site-strict, no org-wide fallback) to the asset's stored IP,
 * and changes only the asset's probe status fields. The route's rules are kept:
 *  - MFA (QW4) and `devices:write` (TOOL_PERMISSIONS);
 *  - the asset is resolved with the route's SITE-LOCKING resolver
 *    (`resolveAssetForMutation`), so a concurrent asset move cannot invalidate the
 *    current-site decision between check and use (QW7); the tool runs in the same
 *    per-call transaction the REST request does;
 *  - a hidden, out-of-site or out-of-device-scope asset is one "not found" (the
 *    route's 403 vs 404 would let a restricted caller fingerprint asset ids);
 *  - the dispatch/stamp/wait itself is services/assetProbeRun.ts, unchanged.
 */
import type { AiTool } from './aiTools';
import { resolveAssetForMutation, type AssetAuthContext } from './assetAccessScope';
import { deviceSiteDenied, siteAllowlistOf } from './aiToolsSiteScope';
import { runAssetProbe } from './assetProbeRun';
import { jsonError, json, mfaDenied, thrown } from './aiToolsNetworkMonitoringShared';

const NOT_FOUND = 'Asset not found or access denied';

export function registerNetworkProbeTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('probe_network_asset', {
    tier: 2,
    domain: 'network',
    searchHint: 'check now: ping a discovered printer, switch, camera or NAS from an agent on its site to see if it is up',
    deviceArgs: [],
    definition: {
      name: 'probe_network_asset',
      description:
        'Check now: ping a discovered network asset from an online agent in the same site and report reachable or not, with response time. One probe per asset at a time; waits up to 8 s, else pending.',
      input_schema: {
        type: 'object' as const,
        properties: {
          assetId: { type: 'string', description: 'Discovered asset UUID' },
        },
        required: ['assetId'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const mfa = mfaDenied(auth);
      if (mfa) return mfa;
      const assetId = typeof input.assetId === 'string' ? input.assetId : '';
      if (!assetId) return jsonError('assetId is required', 'VALIDATION_ERROR');
      // A restricted caller that cannot name a single site or device sees nothing.
      if (siteAllowlistOf(auth)?.length === 0 || auth.allowedDeviceIds?.length === 0) return jsonError(NOT_FOUND, 'NOT_FOUND');

      try {
        const resolved = await resolveAssetForMutation(
          auth as AssetAuthContext,
          { allowedSiteIds: siteAllowlistOf(auth) === undefined ? undefined : [...siteAllowlistOf(auth)!] },
          assetId,
        );
        if ('error' in resolved) return jsonError(NOT_FOUND, 'NOT_FOUND');
        const asset = resolved.asset;
        // Exact-device axis (a device-bound run): the asset must be linked to an allowed device.
        if (deviceSiteDenied(auth, asset.siteId, asset.linkedDeviceId)) return jsonError(NOT_FOUND, 'NOT_FOUND');

        // The tool executor persists the call (ai_tool_executions); there is no route audit hook to fire.
        const result = await runAssetProbe(asset, () => undefined);
        if (result.status === 409 || result.status === 422) {
          return json({ error: result.body.error, code: result.body.code });
        }
        return json({
          ...result.body,
          ...(result.status === 202
            ? { note: 'The probe is still running; read the result with get_network_asset_reachability in a few seconds.' }
            : {}),
        });
      } catch (error) {
        return thrown('probe_network_asset', error);
      }
    },
  });
}
