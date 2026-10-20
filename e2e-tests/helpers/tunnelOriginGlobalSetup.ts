// Global setup for playwright.tunnel-origin.config.ts (#8155 W03). Runs after
// the standard global-setup (which re-applies seed-fixtures.sql), turns host
// mode on for the worktree stack and opts the seeded partner in. The returned
// function is the teardown: the stack goes back to path mode afterwards, so a
// later `wt-stack test` run is not silently on the tunnel origin.
//
// The host-mode keys are wt-stack RUNTIME_KEYS (they survive a re-up), so a
// setup that fails half-way must roll back itself: Playwright only runs a
// teardown that setup managed to return.
import {
  disableTunnelOriginOnStack,
  enableTunnelOriginOnStack,
  setPartnerTunnelOriginOptIn,
} from './tunnelOriginStack';

function restorePathMode(): void {
  try {
    setPartnerTunnelOriginOptIn(null);
  } finally {
    disableTunnelOriginOnStack();
  }
  console.log('[tunnel-origin] host mode off (stack back to path mode)');
}

export default function tunnelOriginGlobalSetup(): () => void {
  try {
    const { appOrigin } = enableTunnelOriginOnStack();
    setPartnerTunnelOriginOptIn(true);
    console.log(`[tunnel-origin] host mode on; app ${appOrigin}, tunnels *.tunnel.localhost`);
  } catch (err) {
    try {
      restorePathMode();
    } catch (rollbackErr) {
      console.error('[tunnel-origin] rollback to path mode FAILED; the stack may still be in host mode', rollbackErr);
    }
    throw err;
  }
  return restorePathMode;
}
