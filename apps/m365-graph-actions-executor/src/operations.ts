import {
  writeActionResultSchema,
  type WriteActionRequest,
  type WriteActionResult,
} from '@breeze/shared/m365';
import type { PinnedCertificateProvider } from './credentials/types';
import { executeGraphWriteAction } from './microsoft/writeActions';
import {
  createMicrosoftTokenClient,
  type MicrosoftTokenClient,
} from './microsoft/tokenClient';
import type { MicrosoftGraphClient } from './microsoft/graphClient';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type TokenClientFactory = (credential: {
  certificatePem: string;
  privateKeyPem: string;
}) => MicrosoftTokenClient;

export interface ExecutorOperationDependencies {
  clientId: string;
  certificateProvider: PinnedCertificateProvider;
  createTokenClient: TokenClientFactory;
  graphClient: MicrosoftGraphClient;
}

export async function executeActionOperation(
  request: WriteActionRequest,
  dependencies: ExecutorOperationDependencies,
): Promise<WriteActionResult> {
  if (!CANONICAL_UUID.test(request.tenantId)) {
    return { success: false, errorCode: 'tenant_mismatch' };
  }

  let credential: { certificatePem: string; privateKeyPem: string };
  try {
    credential = await dependencies.certificateProvider.getConfiguredCertificate();
  } catch {
    return { success: false, errorCode: 'credential_unavailable' };
  }

  let tokenClient: MicrosoftTokenClient | undefined;
  try {
    try {
      tokenClient = dependencies.createTokenClient(credential);
    } catch {
      return { success: false, errorCode: 'credential_unavailable' };
    }
    let accessToken;
    try {
      accessToken = await tokenClient.acquireGraphAppToken({ tenantId: request.tenantId });
    } catch {
      return { success: false, errorCode: 'application_token_invalid' };
    }
    return writeActionResultSchema.parse(
      await executeGraphWriteAction(request.action, { accessToken, graphClient: dependencies.graphClient }),
    );
  } finally {
    tokenClient = undefined;
    credential.certificatePem = '';
    credential.privateKeyPem = '';
  }
}

export function createExecutorOperations(config: {
  clientId: string;
  certificateProvider: PinnedCertificateProvider;
  graphClient: MicrosoftGraphClient;
}) {
  const dependencies: ExecutorOperationDependencies = {
    ...config,
    createTokenClient: (credential) => createMicrosoftTokenClient({
      clientId: config.clientId,
      ...credential,
    }),
  };
  return {
    executeAction: (request: WriteActionRequest) => executeActionOperation(request, dependencies),
  };
}
