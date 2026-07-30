import type { Hono } from 'hono';
import { serve } from '@hono/node-server';

type Serve = (options: {
  fetch: Hono['fetch'];
  hostname: string;
  port: number;
}) => { close(): void };

export function startExecutorServer(
  app: Hono,
  binding: { bindHost: string; port: number },
  serveImpl: Serve = serve as Serve,
): { close(): void } {
  return serveImpl({ fetch: app.fetch, hostname: binding.bindHost, port: binding.port });
}

// startConfiguredExecutor + the M365_COMMS_EXECUTOR_AUTOSTART block are added
// in Task 11, once the operations factory exists to wire.
