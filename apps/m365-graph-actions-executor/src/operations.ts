import {
  writeActionResultSchema,
  type WriteActionRequest,
  type WriteActionResult,
} from '@breeze/shared/m365';
import type { PinnedCertificateProvider } from './credentials/types';
import type { MicrosoftGraphClient } from './microsoft/graphClient';

export interface ExecutorOperationDependencies {
  clientId: string;
  certificateProvider: PinnedCertificateProvider;
  graphClient: MicrosoftGraphClient;
}

// Stub — real implementation lands in Task 4. Fails closed so the route is
// wired and health-checkable without performing any mutation yet.
export async function executeActionOperation(
  _request: WriteActionRequest,
  _dependencies: ExecutorOperationDependencies,
): Promise<WriteActionResult> {
  return writeActionResultSchema.parse({ success: false, errorCode: 'invalid_action' });
}

export function createExecutorOperations(config: ExecutorOperationDependencies) {
  return {
    executeAction: (request: WriteActionRequest) => executeActionOperation(request, config),
  };
}
