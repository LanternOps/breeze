/**
 * Fixture for agentOwnDeviceRowUpdates.contract.test.ts: an agent-route file
 * that reaches a bare `devices` update only through an import spelled with
 * the tsconfig `@/` path alias. The scan must follow the import and flag the
 * site in ../../lib/bareViaAliasPath.ts.
 */
import { bareViaAliasPath } from '@/__tests__/fixtures/agent-own-device-row/lib/bareViaAliasPath';

export const reachesBareUpdateThroughAlias = bareViaAliasPath;
