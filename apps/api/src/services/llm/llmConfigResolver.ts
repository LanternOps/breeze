import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partnerLlmConfigs } from '../../db/schema';
import { resolveDefaultModel } from '../aiAgent';
import { decryptPartnerLlmApiKey } from '../partnerLlmConfig';

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
  | { source: 'unavailable'; partnerId: string; reason: 'key_error' };

export class LlmUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'ai_unavailable';

  constructor() {
    super('AI is unavailable until the Anthropic API key is reconnected.');
    this.name = 'LlmUnavailableError';
  }
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
  } catch {
    try {
      await markPartnerLlmError({
        partnerId,
        configVersion: row.configVersion,
        reason: 'decrypt_failed',
      });
    } catch {
      console.error('[llmConfigResolver] failed to mark unreadable partner config', {
        partnerId,
        configVersion: row.configVersion,
      });
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

/**
 * Marks normalized credential failures only. Callers must not invoke this for
 * Anthropic 429, 5xx, network, timeout, or other retryable failures.
 */
export async function markPartnerLlmError(input: {
  partnerId: string;
  configVersion: number;
  reason: string;
}): Promise<boolean> {
  const reason = input.reason.trim().slice(0, 160) || 'credential_error';
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [updated] = await db
        .update(partnerLlmConfigs)
        .set({
          status: 'error',
          lastError: reason,
          updatedAt: new Date(),
        })
        .where(and(
          eq(partnerLlmConfigs.partnerId, input.partnerId),
          eq(partnerLlmConfigs.configVersion, input.configVersion),
        ))
        .returning({ id: partnerLlmConfigs.id });
      return updated !== undefined;
    }),
  );
}

export async function getAnthropicClientForPartner(partnerId: string | null): Promise<{
  client: Anthropic;
  resolved: Exclude<ResolvedLlmConfig, { source: 'unavailable' }>;
}> {
  const resolved = await resolveLlmConfig(partnerId);
  if (resolved.source === 'unavailable' || !resolved.apiKey?.trim()) {
    throw new LlmUnavailableError();
  }
  return {
    client: new Anthropic({ apiKey: resolved.apiKey }),
    resolved,
  };
}
