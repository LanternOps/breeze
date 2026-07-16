import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { createExecutorApp } from './app';
import { loadExecutorConfig } from './config';
import { AzureKeyVaultCertificateProvider } from './credentials/azureKeyVaultProvider';
import { createEdDsaInternalRequestAuthenticator } from './internalAuth';
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
  return serveImpl({
    fetch: app.fetch,
    hostname: binding.bindHost,
    port: binding.port,
  });
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
  });
  const app = createExecutorApp({ authenticator, ...operations });
  return startExecutorServer(app, config);
}

if (process.env.M365_GRAPH_READ_EXECUTOR_AUTOSTART === '1') {
  void startConfiguredExecutor().catch(() => {
    process.exitCode = 1;
  });
}
