import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { SecretClient } from '@azure/keyvault-secrets';
import { createExecutorApp } from './app';
import { createAzureCredential, loadExecutorConfig } from './config';
import { createEdDsaInternalRequestAuthenticator } from './internalAuth';
import { AzureKeyVaultCertificateProvider, type SecretClientPort } from './credentials/azureKeyVaultProvider';
import { loadKekKeyring } from './credentials/kekKeyringProvider';
import { PostgresTokenCacheStore } from './credentials/postgresTokenCacheStore';
import { DelegatedTokenCache } from './credentials/delegatedTokenCache';
import { createDelegatedCredentialBroker } from './microsoft/delegatedClient';
import { createMicrosoftGraphClient } from './microsoft/graphClient';
import { createExecutorOperations } from './operations';

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

const LOG_PREFIX = '[m365-communications-executor]';

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
  const secretClient = new SecretClient(
    config.vaultUrl,
    createAzureCredential(config.azureCredentialMode),
  ) as unknown as SecretClientPort;
  // fromConfig keeps the sibling's field names (it takes { vaultUrl, vaultRef,
  // credentialVersion, azureCredentialMode }); the comms config's cert fields
  // are adapted at the call site.
  const certificateProvider = AzureKeyVaultCertificateProvider.fromConfig({
    vaultUrl: config.vaultUrl,
    vaultRef: config.clientCertVaultRef,
    credentialVersion: config.clientCertVersion,
    azureCredentialMode: config.azureCredentialMode,
  });
  const keyring = await loadKekKeyring(config, secretClient);
  const store = new PostgresTokenCacheStore(config.tokenCacheDsn);
  await store.ensureSchema();
  const tokenCache = new DelegatedTokenCache({ store, keyring, holderId: randomUUID() });
  const broker = createDelegatedCredentialBroker({
    clientId: config.clientId, certificateProvider, tokenCache,
  });
  const graphClient = createMicrosoftGraphClient({ applicationId: config.clientId });
  const operations = createExecutorOperations({
    clientId: config.clientId, broker, tokenCache, graphClient,
  });
  const app = createExecutorApp({ authenticator, ...operations });
  return startExecutorServer(app, config);
}

if (process.env.M365_COMMS_EXECUTOR_AUTOSTART === '1') {
  void startConfiguredExecutor().catch(reportStartupFailure);
}
