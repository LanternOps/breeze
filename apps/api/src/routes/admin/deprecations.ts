/**
 * Deployment deprecations report (#6605 wave 2).
 *
 *   GET /api/v1/admin/deprecations   manifest entries + this deployment's status
 *
 * Backs Settings → System → Deprecations. Read-only: the route has no write
 * verb and reads only through `readRequestDeploymentState` (SELECTs). It is
 * platform-admin only because it is mounted under `adminRoutes`, whose
 * `platformAdminMiddleware` gates every request — the data describes the whole
 * deployment, not one tenant (decision on #6605, 2026-09-22).
 *
 * Never a 500 for a database problem and never "no issues" when it cannot
 * tell: a failed read yields the broad report, the same contract as the boot
 * preflight.
 */
import { Hono } from 'hono';
import { BREAKING_CHANGES_MANIFEST, BREAKING_CHANGES_MANIFEST_ERROR } from '../../upgrade/breakingChangesManifest';
import { buildDeprecationsView, readRequestDeploymentState } from '../../upgrade/deprecationsReport';
import { unreadableState } from '../../upgrade/upgradePreflightRunner';
import type { DeploymentState } from '../../upgrade/upgradePreflight';

export const deprecationsAdminRoutes = new Hono();

deprecationsAdminRoutes.get('/', async (c) => {
  // The same source the boot preflight and version recording use.
  const currentVersion = process.env.APP_VERSION;
  let state: DeploymentState;
  try {
    state = await readRequestDeploymentState(currentVersion);
  } catch (err) {
    const reason = `could not read the deployment state: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[admin/deprecations] ${reason}`);
    state = unreadableState(currentVersion, reason);
  }
  return c.json({ data: buildDeprecationsView(BREAKING_CHANGES_MANIFEST, state, BREAKING_CHANGES_MANIFEST_ERROR) });
});
