import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partnerLlmConfigs } from '../../db/schema';
import { resolveDefaultModel } from '../aiModel';
import { decryptPartnerLlmApiKey } from '../partnerLlmConfig';
import { SecretKeyMaterialError } from '../secretCrypto';
import { captureException, captureMessage } from '../sentry';

const SENTRY_CAPTURE_THROTTLE_MS = 60 * 60 * 1000;
const sentryCaptureTimestamps = new Map<string, number>();

function captureAtMostHourly(key: string, capture: () => void): void {
  const now = Date.now();
  const lastCapture = sentryCaptureTimestamps.get(key);
  if (lastCapture !== undefined && now - lastCapture < SENTRY_CAPTURE_THROTTLE_MS) return;
  sentryCaptureTimestamps.set(key, now);
  capture();
}

export type ResolvedLlmConfig =
  | { source: 'platform'; apiKey: string | undefined; model: string }
  | {
      source: 'partner';
      partnerId: string;
      apiKey: string;
      model: string;
      configId: string;
      configVersion: number;
    }
  | {
      source: 'unavailable';
      partnerId: string;
      reason: 'key_error' | 'key_material';
    };

export type UsableLlmConfig = Exclude<ResolvedLlmConfig, { source: 'unavailable' }>;

export class LlmUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'ai_unavailable';

  constructor(message = 'AI is unavailable until the Anthropic API key is reconnected.') {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export class LlmOrgResolutionError extends Error {
  readonly orgId: string;

  constructor(orgId: string) {
    super(`Organization ${orgId} could not be resolved for AI configuration.`);
    this.name = 'LlmOrgResolutionError';
    this.orgId = orgId;
  }
}

async function readOrganizationPartnerId(orgId: string): Promise<string | null | undefined> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [organization] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      return organization?.partnerId;
    }),
  );
}

async function readPartnerLlmConfig(partnerId: string) {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({
          id: partnerLlmConfigs.id,
          partnerId: partnerLlmConfigs.partnerId,
          apiKeyEncrypted: partnerLlmConfigs.apiKeyEncrypted,
          defaultModel: partnerLlmConfigs.defaultModel,
          status: partnerLlmConfigs.status,
          configVersion: partnerLlmConfigs.configVersion,
        })
        .from(partnerLlmConfigs)
        .where(eq(partnerLlmConfigs.partnerId, partnerId))
        .limit(1);
      return row;
    }),
  );
}

async function partnerLlmConfigExists(partnerId: string): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ id: partnerLlmConfigs.id })
        .from(partnerLlmConfigs)
        .where(eq(partnerLlmConfigs.partnerId, partnerId))
        .limit(1);
      return row !== undefined;
    }),
  );
}

export async function resolveLlmConfig(partnerId: string | null): Promise<ResolvedLlmConfig> {
  const platform = (): ResolvedLlmConfig => ({
    source: 'platform',
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: resolveDefaultModel(),
  });

  if (!partnerId) return platform();

  const row = await readPartnerLlmConfig(partnerId);
  if (!row) return platform();
  if (row.status === 'error') {
    return { source: 'unavailable', partnerId, reason: 'key_error' };
  }

  let apiKey: string;
  try {
    apiKey = decryptPartnerLlmApiKey({ id: row.id, apiKeyEncrypted: row.apiKeyEncrypted });
  } catch (error) {
    if (error instanceof SecretKeyMaterialError) {
      captureAtMostHourly(`key-material:${partnerId}`, () => {
        captureException(error, undefined, { service: 'llmConfigResolver', partnerId });
      });
      console.error(
        '[llmConfigResolver] partner config cannot be decrypted with this node key material',
        { partnerId, error },
      );
      return { source: 'unavailable', partnerId, reason: 'key_material' };
    }
    captureException(error, undefined, { service: 'llmConfigResolver', partnerId });
    try {
      await markPartnerLlmError({
        configId: row.id,
        configVersion: row.configVersion,
        reason: 'decrypt_failed',
      });
    } catch (markError) {
      console.error('[llmConfigResolver] failed to mark unreadable partner config', {
        partnerId,
        configVersion: row.configVersion,
        error: markError,
      });
      captureException(markError, undefined, { service: 'llmConfigResolver', partnerId });
    }
    return { source: 'unavailable', partnerId, reason: 'key_error' };
  }

  return {
    source: 'partner',
    partnerId,
    apiKey,
    model: row.defaultModel ?? resolveDefaultModel(),
    configId: row.id,
    configVersion: row.configVersion,
  };
}

export async function resolveLlmConfigForOrg(orgId: string): Promise<ResolvedLlmConfig> {
  const partnerId = await readOrganizationPartnerId(orgId);
  if (partnerId === undefined) throw new LlmOrgResolutionError(orgId);
  return resolveLlmConfig(partnerId ?? null);
}

export async function getLlmBillingSourceForOrg(
  orgId: string,
): Promise<'platform' | 'partner_key'> {
  try {
    const partnerId = await readOrganizationPartnerId(orgId);
    if (!partnerId) return 'platform';
    return await partnerLlmConfigExists(partnerId) ? 'partner_key' : 'platform';
  } catch (error) {
    try {
      captureAtMostHourly(`billing-source:${orgId}`, () => {
        captureException(error, undefined, { service: 'llmConfigResolver', orgId });
      });
    } catch {
      // Telemetry must not break this conservative, read-only billing fallback.
    }
    return 'platform';
  }
}

export type PartnerLlmErrorReason = 'decrypt_failed' | 'auth_rejected';

/**
 * Marks normalized credential failures only when the exact config row id and
 * version still match. Callers must not invoke this for Anthropic 429, 5xx,
 * network, timeout, or other retryable failures.
 */
export async function markPartnerLlmError(input: {
  configId: string;
  configVersion: number;
  reason: PartnerLlmErrorReason;
}): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [updated] = await db
        .update(partnerLlmConfigs)
        .set({
          status: 'error',
          lastError: input.reason,
          updatedAt: new Date(),
        })
        .where(and(
          eq(partnerLlmConfigs.id, input.configId),
          eq(partnerLlmConfigs.configVersion, input.configVersion),
        ))
        .returning({ id: partnerLlmConfigs.id });
      return updated !== undefined;
    }),
  );
}

export async function getAnthropicClientForPartner(partnerId: string | null): Promise<{
  client: Anthropic;
  resolved: UsableLlmConfig;
}> {
  const resolved = await resolveLlmConfig(partnerId);
  if (resolved.source === 'unavailable') {
    throw new LlmUnavailableError();
  }
  if (!resolved.apiKey?.trim()) {
    const error = new LlmUnavailableError('AI is not configured on this deployment.');
    captureAtMostHourly('blank-platform-key:platform', () => {
      captureMessage(
        'AI is not configured on this deployment.',
        'warning',
        undefined,
        { service: 'llmConfigResolver' },
      );
    });
    throw error;
  }
  return {
    client: resolved.source === 'partner'
      ? new Anthropic({
          apiKey: resolved.apiKey,
          authToken: null,
          baseURL: 'https://api.anthropic.com',
        })
      : new Anthropic({ apiKey: resolved.apiKey }),
    resolved,
  };
}
