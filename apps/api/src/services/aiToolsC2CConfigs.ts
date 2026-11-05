/**
 * `manage_c2c_configs` (full-control W17, #6788): cloud-to-cloud backup configs,
 * the AI twin of routes/c2c/configs.ts over the same service (c2cConfigService.ts).
 *
 * Classes (aiGuardrails.ts, plan W17):
 *  - `list` is a tier-1 read.
 *  - `create` and `update` are supervised, not tier 2: a config chooses whose mail
 *    is copied, to which storage and on what schedule, and `auto_approve` runs tier 2
 *    without a prompt. The schedule poller (`check-schedules`) already reads these
 *    rows; sync itself is a stub today, and the class is for what it will do.
 *  - `delete` is supervised. It is refused while history depends on the config.
 *
 * Human-only (`AGENT_HUMAN_ONLY_TOOLS`): `list` returns target mailboxes and the
 * writes choose what is copied, so an agent is refused here too, reads included.
 * A config is org-wide, so a device-bound session cannot read or write one, and a
 * site-restricted caller cannot change one (stricter than REST, as W11-D6).
 */
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { createC2cConfigSchema, updateC2cConfigSchema, c2cBackupScopes } from '../routes/c2c/schemas';
import { mfaGatedToolError } from './aiToolMfaGate';
import { C2C_CONFIG_ACTIONS } from './aiToolSchemasC2CConfigs';
import {
  C2C_CONFIG_HAS_HISTORY_MESSAGE,
  createC2cConfig,
  deleteC2cConfig,
  listC2cConfigs,
  toC2cConfigResponse,
  updateC2cConfig,
  type C2cConfigErrorCode,
  type C2cConfigRow,
} from './c2cConfigService';
import { PROTECTED_ORG_ERROR } from './unassignedPool/orgType';
import { WRITE_ORG_AMBIGUOUS_ERROR, resolveReadableToolOrgScope, resolveWritableToolOrgId } from './aiToolWriteOrg';
import { auditToolWrite, bounded, defined, deviceBoundDenied, json, jsonError, notFound, orgWideWriteDenied, str, thrown } from './aiToolsSecurityPolicyShared';
import { agentRefusal, isAgentPrincipal } from './aiToolsTicketOpsShared';
import { clampLimit } from './aiToolsSoftwareShared';

type Action = (typeof C2C_CONFIG_ACTIONS)[number];

const TOOL = 'manage_c2c_configs';
const TARGET_USERS_SHOWN = 100;
const WHAT = 'A cloud-to-cloud backup config';

function projectConfig(row: C2cConfigRow) {
  const { targetUsers, ...config } = toC2cConfigResponse(row);
  return { ...config, targetUserCount: targetUsers.length, targetUsers: targetUsers.slice(0, TARGET_USERS_SHOWN) };
}

function serviceError(code: C2cConfigErrorCode): string {
  switch (code) {
    case 'NOT_FOUND':
      return notFound('Cloud-to-cloud backup config');
    case 'CONNECTION_NOT_FOUND':
      return jsonError('Connection not found in this organization (see query_c2c_connections)', code);
    case 'STORAGE_NOT_FOUND':
      return jsonError('Storage config not found in this organization', code);
    case 'PROTECTED_ORG':
      return jsonError(PROTECTED_ORG_ERROR.error, code);
    case 'CONFIG_HAS_HISTORY':
      return jsonError(C2C_CONFIG_HAS_HISTORY_MESSAGE, code);
  }
}

function readOrg(auth: AuthContext, inputOrgId: string | undefined): { orgId: string } | { error: string } {
  const scope = resolveReadableToolOrgScope(auth, inputOrgId);
  if (!scope.ok) return { error: jsonError(scope.error, inputOrgId ? 'ACCESS_DENIED' : 'VALIDATION_ERROR') };
  const [orgId, ...others] = scope.orgIds;
  if (!orgId || others.length > 0) return { error: jsonError(WRITE_ORG_AMBIGUOUS_ERROR, 'VALIDATION_ERROR') };
  return { orgId };
}

function writeOrg(auth: AuthContext, inputOrgId: string | undefined): { orgId: string } | { error: string } {
  const resolved = resolveWritableToolOrgId(auth, inputOrgId);
  if (resolved.orgId) return { orgId: resolved.orgId };
  return { error: jsonError(resolved.error ?? 'Organization context required', inputOrgId ? 'ACCESS_DENIED' : 'VALIDATION_ERROR') };
}

function firstIssue(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'Invalid input';
}

async function list(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  const org = readOrg(auth, str(input.orgId));
  if ('error' in org) return org.error;
  const rows = await listC2cConfigs(org.orgId);
  const limit = clampLimit(input.limit, 50, 100);
  const configs = rows.slice(0, limit).map(projectConfig);
  return bounded({ count: configs.length, total: rows.length, configs });
}

async function create(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  const parsed = createC2cConfigSchema.safeParse(defined({
    connectionId: input.connectionId,
    name: input.name,
    backupScope: input.backupScope,
    targetUsers: input.targetUsers,
    // REST takes no null here; a create with no storage simply omits it.
    storageConfigId: input.storageConfigId ?? undefined,
    schedule: input.schedule,
    retention: input.retention,
  }));
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 'VALIDATION_ERROR');
  const org = writeOrg(auth, str(input.orgId));
  if ('error' in org) return org.error;

  const result = await createC2cConfig(org.orgId, parsed.data);
  if (!result.ok) return serviceError(result.code);
  const row = result.value;
  auditToolWrite(auth, {
    orgId: org.orgId,
    action: 'c2c.config.create',
    resourceType: 'c2c_backup_config',
    resourceId: row.id,
    resourceName: row.name,
    details: { scope: row.backupScope, connectionId: row.connectionId },
  });
  return json({ config: projectConfig(row) });
}

async function update(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  const configId = str(input.configId);
  if (!configId) return jsonError('configId is required for update', 'VALIDATION_ERROR');
  if (input.connectionId !== undefined) {
    return jsonError('connectionId cannot be changed; create a new config for another connection', 'VALIDATION_ERROR');
  }
  const parsed = updateC2cConfigSchema.safeParse(defined({
    name: input.name,
    backupScope: input.backupScope,
    targetUsers: input.targetUsers,
    storageConfigId: input.storageConfigId,
    schedule: input.schedule,
    retention: input.retention,
    isActive: input.isActive,
  }));
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 'VALIDATION_ERROR');
  const changedFields = Object.keys(parsed.data);
  if (changedFields.length === 0) return jsonError('Name at least one field to change', 'VALIDATION_ERROR');
  const org = writeOrg(auth, str(input.orgId));
  if ('error' in org) return org.error;

  const result = await updateC2cConfig(org.orgId, configId, parsed.data);
  if (!result.ok) return serviceError(result.code);
  const row = result.value;
  auditToolWrite(auth, {
    orgId: org.orgId,
    action: 'c2c.config.update',
    resourceType: 'c2c_backup_config',
    resourceId: row.id,
    resourceName: row.name,
    details: { changedFields },
  });
  return json({ config: projectConfig(row) });
}

async function remove(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  const configId = str(input.configId);
  if (!configId) return jsonError('configId is required for delete', 'VALIDATION_ERROR');
  const org = writeOrg(auth, str(input.orgId));
  if ('error' in org) return org.error;

  const result = await deleteC2cConfig(org.orgId, configId);
  if (!result.ok) return serviceError(result.code);
  auditToolWrite(auth, {
    orgId: org.orgId,
    action: 'c2c.config.delete',
    resourceType: 'c2c_backup_config',
    resourceId: result.value.id,
    resourceName: result.value.name,
  });
  return json({ deleted: true, configId });
}

export function registerC2CConfigTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_c2c_configs', {
    tier: 1,
    domain: 'integrations',
    searchHint: 'cloud-to-cloud backup config: which mailboxes, schedule, retention, storage; Microsoft 365 or Google Workspace',
    definition: {
      name: 'manage_c2c_configs',
      description:
        'Cloud-to-cloud backup configs. Actions: list, create (connectionId, name, backupScope), update (configId), delete (configId, refused when it has backup history). Writes choose whose mail is copied and need approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...C2C_CONFIG_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (required when you can reach several)' },
          configId: { type: 'string', description: 'Config UUID from list (update, delete)' },
          connectionId: { type: 'string', description: 'create: connection UUID from query_c2c_connections. Cannot be changed later' },
          name: { type: 'string', description: 'create, update: config name' },
          backupScope: { type: 'string', enum: [...c2cBackupScopes], description: 'create, update: what to back up' },
          targetUsers: { type: 'array', items: { type: 'string' }, description: 'create, update: email addresses of the users to back up' },
          storageConfigId: { type: ['string', 'null'], description: 'create, update: backup config UUID for storage. update: null clears it' },
          schedule: {
            type: 'object',
            description: 'create, update: when it runs',
            properties: {
              frequency: { type: 'string', enum: ['hourly', 'daily', 'weekly'], description: 'How often' },
              time: { type: 'string', description: 'HH:MM' },
              dayOfWeek: { type: 'number', description: '0-6, for weekly' },
            },
            required: ['frequency'],
          },
          retention: {
            type: 'object',
            description: 'create, update: how long to keep backups',
            properties: {
              keepDays: { type: 'number', description: 'Days, 1-3650' },
              keepVersions: { type: 'number', description: 'Versions, 1-1000' },
            },
          },
          isActive: { type: 'boolean', description: 'update: false stops the schedule' },
          limit: { type: 'number', description: 'Max rows for list (default 50, max 100)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!C2C_CONFIG_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      if (isAgentPrincipal(auth)) return agentRefusal(action);
      const mfa = mfaGatedToolError(TOOL, action, auth);
      if (mfa) return mfa;
      const bound = deviceBoundDenied(auth, WHAT);
      if (bound) return bound;
      if (action !== 'list') {
        const denied = orgWideWriteDenied(auth, WHAT);
        if (denied) return denied;
      }
      try {
        if (action === 'list') return await list(auth, input);
        if (action === 'create') return await create(auth, input);
        if (action === 'update') return await update(auth, input);
        return await remove(auth, input);
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}
