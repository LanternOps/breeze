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
}) => { close(): void };

export function startExecutorServer(
  app: Hono,
  binding: { bindHost: string; port: number },
  serveImpl: Serve = serve as Serve,
): { close(): void } {
  return serveImpl({ fetch: app.fetch, hostname: binding.bindHost, port: binding.port });
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
  void startConfiguredExecutor().catch(() => { process.exitCode = 1; });
}
