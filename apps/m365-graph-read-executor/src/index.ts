import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { createExecutorApp } from './app';
import { loadExecutorConfig } from './config';
import { AzureKeyVaultCertificateProvider } from './credentials/azureKeyVaultProvider';
import { createInFlightGate } from './inFlight';
import { createEdDsaInternalRequestAuthenticator } from './internalAuth';
import { createMicrosoftGraphClient } from './microsoft/graphClient';
import { createExecutorOperations } from './operations';
import { createSigninLimiter } from './signinLimiter';
import { createSigninEventsLimiter } from './signinEventsLimiter';
import { createSyncContinuationCodec } from './syncContinuation';

type Serve = (options: {
  fetch: Hono['fetch'];
  hostname: string;
  port: number;
}) => ExecutorServer;

// node:http's Server is an EventEmitter; test fakes may omit `on`.
type ExecutorServer = {
  close(): void;
  on?(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
};

const LOG_PREFIX = '[m365-graph-read-executor]';

export function startExecutorServer(
  app: Hono,
  binding: { bindHost: string; port: number },
  serveImpl: Serve = serve as Serve,
): { close(): void } {
  const server = serveImpl({
    fetch: app.fetch,
    hostname: binding.bindHost,
    port: binding.port,
  });
  // listen() fails asynchronously (EADDRINUSE / EADDRNOTAVAIL), after this
  // function has returned, so the startup catch below never sees it. Log the
  // code and exit so the platform restarts the replica instead of hanging.
  server.on?.('error', (error) => {
    console.error(`${LOG_PREFIX} server error: ${error.code ?? error.message}`);
    process.exit(1);
  });
  return server;
}

// Config errors name the env var and its fixed requirement, never the supplied
// value; log only that message (no stack, cause, or config object).
export function reportStartupFailure(error: unknown): void {
  console.error(`${LOG_PREFIX} startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}

export async function startConfiguredExecutor(): Promise<{ close(): void }> {
  const config = loadExecutorConfig();
  const authenticator = await createEdDsaInternalRequestAuthenticator({
    publicJwk: config.internalAuthPublicJwk,
    kid: config.internalAuthKid,
  });
  const certificateProvider = AzureKeyVaultCertificateProvider.fromConfig(config);
  const graphClient = createMicrosoftGraphClient({ applicationId: config.clientId });
  const operations = createExecutorOperations({
    clientId: config.clientId,
    callbackUrl: config.callbackUrl,
    certificateProvider,
    graphClient,
    sync: {
      limits: config.sync,
      continuations: createSyncContinuationCodec({ key: config.sync.continuationKey }),
      signinLimiter: createSigninLimiter({ requestsPerMinute: config.sync.signinActivityRpm }),
      signinEventsLimiter: createSigninEventsLimiter({ requestsPerMinute: config.sync.signinEventsRpm }),
    },
  });
  const app = createExecutorApp({
    authenticator,
    ...operations,
    gate: createInFlightGate({
      syncMaxInFlight: config.sync.syncMaxInFlight,
      maxInFlight: config.sync.maxInFlight,
    }),
  });
  return startExecutorServer(app, config);
}

if (process.env.M365_GRAPH_READ_EXECUTOR_AUTOSTART === '1') {
  void startConfiguredExecutor().catch(reportStartupFailure);
}
