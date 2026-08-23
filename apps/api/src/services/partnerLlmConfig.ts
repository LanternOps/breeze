import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partnerLlmConfigs } from '../db/schema';
import { resolveDefaultModel } from './aiAgent';
import { SUPPORTED_AI_MODELS } from './aiCostTracker';
import {
  columnAad,
  encryptedColumnRegistry,
  type EncryptedColumnSpec,
} from './encryptedColumnRegistry';
import { decryptSecret, encryptSecret, hmacFingerprint } from './secretCrypto';
import { captureException } from './sentry';

const API_KEY_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (entry) => entry.table === 'partner_llm_configs' && entry.column === 'api_key_encrypted',
  );
  if (!spec) throw new Error('partner_llm_configs.api_key_encrypted is missing from encryptedColumnRegistry');
  return spec;
})();

export class PartnerLlmError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 409 | 500 | 503,
  ) {
    super(message);
    this.name = 'PartnerLlmError';
  }
}

export interface PartnerLlmStatus {
  configured: boolean;
  provider: 'anthropic';
  keyLast4: string | null;
  defaultModel: string | null;
  status: 'platform' | 'active' | 'error';
  verifiedAt: Date | null;
  lastError: string | null;
}

function encryptPartnerLlmApiKey(id: string, apiKey: string): string {
  const encrypted = encryptSecret(apiKey, { aad: columnAad(API_KEY_SPEC, id) });
  if (!encrypted) throw new PartnerLlmError('Could not encrypt the Anthropic API key.', 500);
  return encrypted;
}

export function decryptPartnerLlmApiKey(row: { id: string; apiKeyEncrypted: string }): string {
  const apiKey = decryptSecret(row.apiKeyEncrypted, { aad: columnAad(API_KEY_SPEC, row.id) });
  if (!apiKey) throw new Error('Stored Anthropic API key decrypted to an empty value');
  return apiKey;
}

async function probeAnthropicKey(apiKey: string): Promise<void> {
  const model = resolveDefaultModel();
  try {
    const client = new Anthropic({ apiKey });
    await runOutsideDbContext(() => client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }));
  } catch (error) {
    if (!(error instanceof Anthropic.APIError)) throw error;
    const status = error.status;
    if (status === 401) {
      throw new PartnerLlmError('That Anthropic API key was rejected. Check the key and try again.', 400);
    }
    if (status === 403) {
      throw new PartnerLlmError('Anthropic denied access for that API key. Check its permissions and try again.', 409);
    }
    if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
      captureException(error, undefined, { service: 'partnerLlmConfig' });
      throw new PartnerLlmError(
        `Anthropic rejected the verification request (HTTP ${status}). ` +
        'The probe model may be unavailable — contact support if this persists.',
        400,
      );
    }
    throw new PartnerLlmError('Anthropic could not verify the API key right now. Try again later.', 503);
  }
}

export async function savePartnerLlmKey(input: {
  partnerId: string;
  apiKey: string;
  userId: string;
}): Promise<{
  last4: string;
  model: string;
  verifiedAt: Date;
  configVersion: number;
}> {
  const apiKey = input.apiKey.trim();
  if (apiKey.startsWith('enc:')) {
    throw new PartnerLlmError('Anthropic API keys must not start with the encrypted-value prefix.', 400);
  }

  await probeAnthropicKey(apiKey);

  const id = randomUUID();
  const last4 = apiKey.slice(-4);
  const fingerprint = hmacFingerprint(apiKey);
  const verifiedAt = new Date();

  const stored = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [inserted] = await db
        .insert(partnerLlmConfigs)
        .values({
          id,
          partnerId: input.partnerId,
          apiKeyEncrypted: encryptPartnerLlmApiKey(id, apiKey),
          keyLast4: last4,
          keyFingerprint: fingerprint,
          status: 'active',
          configVersion: 1,
          lastError: null,
          verifiedAt,
          connectedBy: input.userId,
          updatedAt: verifiedAt,
        })
        .onConflictDoNothing({ target: partnerLlmConfigs.partnerId })
        .returning({ id: partnerLlmConfigs.id, configVersion: partnerLlmConfigs.configVersion });

      if (inserted) {
        return { configVersion: inserted.configVersion, defaultModel: null as string | null };
      }

      const [existing] = await db
        .select({
          id: partnerLlmConfigs.id,
          defaultModel: partnerLlmConfigs.defaultModel,
        })
        .from(partnerLlmConfigs)
        .where(eq(partnerLlmConfigs.partnerId, input.partnerId))
        .limit(1);
      if (!existing) {
        throw new PartnerLlmError('Could not replace the Anthropic API key.', 500);
      }

      const [updated] = await db
        .update(partnerLlmConfigs)
        .set({
          apiKeyEncrypted: encryptPartnerLlmApiKey(existing.id, apiKey),
          keyLast4: last4,
          keyFingerprint: fingerprint,
          status: 'active',
          configVersion: sql`${partnerLlmConfigs.configVersion} + 1`,
          lastError: null,
          verifiedAt,
          connectedBy: input.userId,
          updatedAt: verifiedAt,
        })
        .where(and(
          eq(partnerLlmConfigs.partnerId, input.partnerId),
          eq(partnerLlmConfigs.id, existing.id),
        ))
        .returning({ configVersion: partnerLlmConfigs.configVersion });
      if (!updated) {
        throw new PartnerLlmError('Could not replace the Anthropic API key.', 500);
      }
      return { configVersion: updated.configVersion, defaultModel: existing.defaultModel };
    }),
  );

  return {
    last4,
    model: stored.defaultModel ?? resolveDefaultModel(),
    verifiedAt,
    configVersion: stored.configVersion,
  };
}

export async function getPartnerLlmStatus(partnerId: string): Promise<PartnerLlmStatus> {
  const [row] = await db
    .select({
      provider: partnerLlmConfigs.provider,
      keyLast4: partnerLlmConfigs.keyLast4,
      defaultModel: partnerLlmConfigs.defaultModel,
      status: partnerLlmConfigs.status,
      verifiedAt: partnerLlmConfigs.verifiedAt,
      lastError: partnerLlmConfigs.lastError,
    })
    .from(partnerLlmConfigs)
    .where(eq(partnerLlmConfigs.partnerId, partnerId))
    .limit(1);

  if (!row) {
    return {
      configured: false,
      provider: 'anthropic',
      keyLast4: null,
      defaultModel: null,
      status: 'platform',
      verifiedAt: null,
      lastError: null,
    };
  }

  return {
    configured: true,
    provider: 'anthropic',
    keyLast4: row.keyLast4,
    defaultModel: row.defaultModel,
    status: row.status,
    verifiedAt: row.verifiedAt,
    lastError: row.lastError,
  };
}

export async function updatePartnerLlmConfig(input: {
  partnerId: string;
  defaultModel: string | null;
}): Promise<{ defaultModel: string | null; configVersion: number }> {
  if (input.defaultModel !== null && !SUPPORTED_AI_MODELS.includes(input.defaultModel)) {
    throw new PartnerLlmError('Unsupported Anthropic model.', 400);
  }

  const [updated] = await db
    .update(partnerLlmConfigs)
    .set({
      defaultModel: input.defaultModel,
      configVersion: sql`${partnerLlmConfigs.configVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(partnerLlmConfigs.partnerId, input.partnerId))
    .returning({ configVersion: partnerLlmConfigs.configVersion });
  if (!updated) {
    throw new PartnerLlmError('Connect an Anthropic API key before selecting a model.', 409);
  }

  return {
    defaultModel: input.defaultModel,
    configVersion: updated.configVersion,
  };
}

export async function deletePartnerLlmConfig(partnerId: string): Promise<boolean> {
  const [deleted] = await db
    .delete(partnerLlmConfigs)
    .where(eq(partnerLlmConfigs.partnerId, partnerId))
    .returning({ id: partnerLlmConfigs.id });
  return deleted !== undefined;
}
