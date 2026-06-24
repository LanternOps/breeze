import { eq } from 'drizzle-orm';
import { db } from '../db';
import { tdSynnexEcExpressIntegrations } from '../db/schema';
import { encryptSecret, decryptForColumn } from './secretCrypto';
import type { CatalogActor } from './catalogService';

const TABLE = 'td_synnex_ec_express_integrations';
const CREDENTIALS_COLUMN = 'credentials';
export const EC_MASKED_SECRET = '********';

const REGION_ENDPOINTS: Record<string, string> = {
  US: 'https://ws.synnex.com/webservice/pnaserviceV05',
};

// Single source of truth for the HTTP status each error code maps to.
const EC_ERROR_STATUS = {
  EC_PARTNER_REQUIRED: 400,
  EC_NOT_CONFIGURED: 404,
  EC_DISABLED: 400,
  EC_CREDENTIALS_INVALID: 400,
  EC_AUTH_FAILED: 401,
  EC_PROVIDER_ERROR: 502,
  EC_NO_RESULTS: 404,
  EC_DUPLICATE_SKU: 409,
  EC_UNSUPPORTED_REGION: 400,
} as const;

export type TdSynnexEcExpressErrorCode = keyof typeof EC_ERROR_STATUS;

export class TdSynnexEcExpressError extends Error {
  public readonly status: number;
  constructor(
    message: string,
    public readonly code: TdSynnexEcExpressErrorCode = 'EC_PROVIDER_ERROR'
  ) {
    super(message);
    this.name = 'TdSynnexEcExpressError';
    this.status = EC_ERROR_STATUS[code];
  }
}

export interface TdSynnexEcExpressCredentials {
  email?: string | null;
  password?: string | null;
  customerNo?: string | null;
}

export interface TdSynnexEcExpressSettings {
  defaultWarehouse?: string;
  hideZeroInv?: boolean;
  defaultMarkupPercent?: number;
}

export interface TdSynnexEcExpressConfigInput {
  region: string;
  enabled: boolean;
  credentials?: TdSynnexEcExpressCredentials;
  settings?: TdSynnexEcExpressSettings;
}

export interface TdSynnexEcProduct {
  source: 'td_synnex_ec_express';
  synnexSku: string;
  mfgPartNo: string | null;
  status: string | null;
  name: string;
  description: string | null;
  currency: string | null;
  cost: string | null;       // <price> = reseller cost
  msrp: string | null;
  discount: string | null;
  totalQty: number | null;
  warehouses: Array<{ code: string | null; available: number; onOrder: number; bo: number; eta: string | null }>;
  weight: string | null;
  parcelShippable: string | null;
  raw: Record<string, unknown>;
}

function requirePartner(actor: CatalogActor): string {
  if (!actor.partnerId) {
    throw new TdSynnexEcExpressError('EC Express integration is partner-scoped', 'EC_PARTNER_REQUIRED');
  }
  return actor.partnerId;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function decryptCredential(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  // A present-but-non-string credential means the stored JSONB is corrupt — fail
  // loudly with an actionable code instead of silently treating it as "absent".
  if (typeof value !== 'string') {
    throw new TdSynnexEcExpressError(
      'Stored EC Express credentials are corrupt — re-enter them',
      'EC_CREDENTIALS_INVALID'
    );
  }
  if (value.length === 0) return null;
  return decryptForColumn(TABLE, CREDENTIALS_COLUMN, value);
}

function mergeCredentialField(
  output: Record<string, unknown>,
  key: 'email' | 'password' | 'customerNo',
  value: unknown
) {
  if (value === undefined || value === EC_MASKED_SECRET) return;
  if (value === null || (typeof value === 'string' && value.trim().length === 0)) {
    delete output[key];
    return;
  }
  if (typeof value === 'string') {
    output[key] = encryptSecret(value.trim());
  }
}

function mergeCredentials(
  existing: unknown,
  next: TdSynnexEcExpressCredentials | undefined
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...asRecord(existing) };
  if (!next) return output;
  mergeCredentialField(output, 'email', next.email);
  mergeCredentialField(output, 'password', next.password);
  mergeCredentialField(output, 'customerNo', next.customerNo);
  return output;
}

function maskConfig(row: typeof tdSynnexEcExpressIntegrations.$inferSelect | null) {
  if (!row) {
    return { configured: false, enabled: false };
  }
  const c = asRecord(row.credentials);
  const hasEmail = typeof c.email === 'string' && c.email.length > 0;
  const hasPassword = typeof c.password === 'string' && c.password.length > 0;
  const hasCustomerNo = typeof c.customerNo === 'string' && c.customerNo.length > 0;
  return {
    configured: hasEmail && hasPassword && hasCustomerNo,
    id: row.id,
    region: row.region,
    enabled: row.enabled,
    credentials: {
      email: hasEmail ? EC_MASKED_SECRET : '',
      password: hasPassword ? EC_MASKED_SECRET : '',
      customerNo: hasCustomerNo ? EC_MASKED_SECRET : '',
    },
    settings: asRecord(row.settings),
    lastTestStatus: row.lastTestStatus,
    lastTestAt: row.lastTestAt,
    lastTestError: row.lastTestError,
  };
}

export async function getEcExpressStatus(actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const [row] = await db
    .select()
    .from(tdSynnexEcExpressIntegrations)
    .where(eq(tdSynnexEcExpressIntegrations.partnerId, partnerId))
    .limit(1);
  return maskConfig(row ?? null);
}

export async function saveEcExpressConfig(input: TdSynnexEcExpressConfigInput, actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  if (!REGION_ENDPOINTS[input.region]) {
    throw new TdSynnexEcExpressError(`Unsupported region: ${input.region}`, 'EC_UNSUPPORTED_REGION');
  }
  const [current] = await db
    .select()
    .from(tdSynnexEcExpressIntegrations)
    .where(eq(tdSynnexEcExpressIntegrations.partnerId, partnerId))
    .limit(1);
  const credentials = mergeCredentials(current?.credentials, input.credentials);
  const settings = {
    defaultWarehouse: 'ANY',
    hideZeroInv: false,
    ...asRecord(current?.settings),
    ...asRecord(input.settings),
  };
  const [row] = await db
    .insert(tdSynnexEcExpressIntegrations)
    .values({
      partnerId,
      region: input.region,
      credentials,
      settings,
      enabled: input.enabled,
      createdBy: actor.userId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tdSynnexEcExpressIntegrations.partnerId,
      set: {
        region: input.region,
        credentials,
        settings,
        enabled: input.enabled,
        updatedAt: new Date(),
      },
    })
    .returning();
  return maskConfig(row ?? null);
}

// --- internal helpers reused by Tasks 3/4 ---

export function endpointForRegion(region: string): string {
  const url = REGION_ENDPOINTS[region];
  if (!url) {
    throw new TdSynnexEcExpressError(`Unsupported region: ${region}`, 'EC_UNSUPPORTED_REGION');
  }
  return url;
}

export function decryptCredentials(
  row: typeof tdSynnexEcExpressIntegrations.$inferSelect
): { email: string; password: string; customerNo: string } {
  const c = asRecord(row.credentials);
  const email = decryptCredential(c.email);
  const password = decryptCredential(c.password);
  const customerNo = decryptCredential(c.customerNo);
  if (!email || !password || !customerNo) {
    throw new TdSynnexEcExpressError(
      'EC Express credentials are not fully configured',
      'EC_CREDENTIALS_INVALID'
    );
  }
  return { email, password, customerNo };
}
