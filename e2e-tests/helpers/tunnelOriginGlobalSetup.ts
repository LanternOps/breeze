// Global setup for playwright.tunnel-origin.config.ts (#8155 W03). Runs after
// the standard global-setup (which re-applies seed-fixtures.sql), turns host
// mode on for the worktree stack and opts the seeded partner in. The returned
// function is the teardown: the stack goes back to path mode afterwards, so a
// later `wt-stack test` run is not silently on the tunnel origin.
import {
  disableTunnelOriginOnStack,
  enableTunnelOriginOnStack,
  setPartnerTunnelOriginOptIn,
} from './tunnelOriginStack';

export default function tunnelOriginGlobalSetup(): () => void {
  const { appOrigin } = enableTunnelOriginOnStack();
  setPartnerTunnelOriginOptIn(true);
  console.log(`[tunnel-origin] host mode on; app ${appOrigin}, tunnels *.tunnel.localhost`);
  return () => {
    setPartnerTunnelOriginOptIn(null);
    disableTunnelOriginOnStack();
    console.log('[tunnel-origin] host mode off (stack back to path mode)');
  };
}
