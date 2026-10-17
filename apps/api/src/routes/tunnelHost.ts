import { Hono } from 'hono';

/**
 * Network Proxy host-mode app (spec 2026-10-06 §3–§6). Reached only through
 * tunnelHostDispatch for an asserted tunnel Host. Until the full handler
 * lands (W02), every tunnel-host request fails closed.
 */
export const tunnelHostRoutes = new Hono();
tunnelHostRoutes.all('*', (c) => c.text('Not found', 404));
