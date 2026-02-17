import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, securityStatus, organizations } from '../../db/schema';
import { CloudflareMtlsService } from '../../services/cloudflareMtls';
import type { SecurityProviderValue, SecurityStatusPayload } from './schemas';
import { uuidRegex } from './schemas';

export type AgentContext = { orgId?: string; agentId?: string; deviceId?: string };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asBoolean(value: unknown, defaultValue = false): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

export function asInt(value: unknown, defaultValue = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return defaultValue;
}

export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeStateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidRegex.test(value);
}

export function parseEnvBoundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

export function normalizeProvider(raw: unknown): SecurityProviderValue {
  if (typeof raw !== 'string') return 'other';
  const value = raw.trim().toLowerCase();
  switch (value) {
    case 'windows_defender':
    case 'microsoft_defender':
    case 'defender':
    case 'prov-defender':
      return 'windows_defender';
    case 'bitdefender':
    case 'prov-bitdefender':
      return 'bitdefender';
    case 'sophos':
      return 'sophos';
    case 'sentinelone':
    case 'sentinel_one':
    case 'sentinel':
    case 'prov-sentinelone':
      return 'sentinelone';
    case 'crowdstrike':
    case 'prov-crowdstrike':
      return 'crowdstrike';
    case 'malwarebytes':
      return 'malwarebytes';
    case 'eset':
      return 'eset';
    case 'kaspersky':
      return 'kaspersky';
    default:
      return 'other';
  }
}

export function normalizeEncryptionStatus(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  if (value === 'encrypted' || value === 'partial' || value === 'unencrypted' || value === 'unknown') {
    return value;
  }
  if (value.includes('encrypt')) return 'encrypted';
  if (value.includes('unencrypt')) return 'unencrypted';
  return value.slice(0, 50);
}

export function normalizeSeverity(raw: unknown): 'low' | 'medium' | 'high' | 'critical' {
  if (typeof raw !== 'string') return 'medium';
  const value = raw.trim().toLowerCase();
  if (value === 'critical') return 'critical';
  if (value === 'high') return 'high';
  if (value === 'low') return 'low';
  return 'medium';
}

export function normalizeKnownOsType(raw: unknown): 'windows' | 'macos' | 'linux' | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'windows' || value === 'macos' || value === 'linux') {
    return value;
  }
  return null;
}

export function inferPatchOsType(source: string, deviceOs: unknown): 'windows' | 'macos' | 'linux' | null {
  const normalizedDeviceOs = normalizeKnownOsType(deviceOs);
  if (normalizedDeviceOs) {
    return normalizedDeviceOs;
  }

  switch (source) {
    case 'microsoft':
      return 'windows';
    case 'apple':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return null;
  }
}

export async function upsertSecurityStatusForDevice(deviceId: string, payload: SecurityStatusPayload): Promise<void> {
  const avProducts = Array.isArray(payload.avProducts) ? payload.avProducts : [];
  const preferredProduct = avProducts.find((p) => p.realTimeProtection) ?? avProducts[0];
  const provider = normalizeProvider(payload.provider ?? preferredProduct?.provider);

  await db
    .insert(securityStatus)
    .values({
      deviceId,
      provider,
      providerVersion: asString(payload.providerVersion) ?? null,
      definitionsVersion: asString(payload.definitionsVersion) ?? null,
      definitionsDate: parseDate(payload.definitionsDate),
      realTimeProtection: payload.realTimeProtection ?? preferredProduct?.realTimeProtection ?? false,
      lastScan: parseDate(payload.lastScan),
      lastScanType: asString(payload.lastScanType) ?? null,
      threatCount: payload.threatCount ?? 0,
      firewallEnabled: payload.firewallEnabled ?? null,
      encryptionStatus: normalizeEncryptionStatus(payload.encryptionStatus),
      encryptionDetails: payload.encryptionDetails ?? null,
      localAdminSummary: payload.localAdminSummary ?? null,
      passwordPolicySummary: payload.passwordPolicySummary ?? null,
      gatekeeperEnabled: payload.gatekeeperEnabled ?? payload.guardianEnabled ?? null,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: securityStatus.deviceId,
      set: {
        provider,
        providerVersion: asString(payload.providerVersion) ?? null,
        definitionsVersion: asString(payload.definitionsVersion) ?? null,
        definitionsDate: parseDate(payload.definitionsDate),
        realTimeProtection: payload.realTimeProtection ?? preferredProduct?.realTimeProtection ?? false,
        lastScan: parseDate(payload.lastScan),
        lastScanType: asString(payload.lastScanType) ?? null,
        threatCount: payload.threatCount ?? 0,
        firewallEnabled: payload.firewallEnabled ?? null,
        encryptionStatus: normalizeEncryptionStatus(payload.encryptionStatus),
        encryptionDetails: payload.encryptionDetails ?? null,
        localAdminSummary: payload.localAdminSummary ?? null,
        passwordPolicySummary: payload.passwordPolicySummary ?? null,
        gatekeeperEnabled: payload.gatekeeperEnabled ?? payload.guardianEnabled ?? null,
        updatedAt: new Date()
      }
    });
}

export async function getOrgMtlsSettings(orgId: string): Promise<{ certLifetimeDays: number; expiredCertPolicy: 'auto_reissue' | 'quarantine' }> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const settings = isObject(org?.settings) ? org.settings : {};
  const mtls = isObject(settings.mtls) ? settings.mtls : {};
  const certLifetimeDays = typeof mtls.certLifetimeDays === 'number' && mtls.certLifetimeDays >= 1 && mtls.certLifetimeDays <= 365
    ? Math.round(mtls.certLifetimeDays)
    : 90;
  const expiredCertPolicy = mtls.expiredCertPolicy === 'quarantine' ? 'quarantine' : 'auto_reissue';
  return { certLifetimeDays, expiredCertPolicy };
}

export async function issueMtlsCertForDevice(deviceId: string, orgId: string): Promise<{
  certificate: string;
  privateKey: string;
  expiresAt: string;
  serialNumber: string;
} | null> {
  const cfService = CloudflareMtlsService.fromEnv();
  if (!cfService) return null;

  let cert;
  try {
    const mtlsSettings = await getOrgMtlsSettings(orgId);
    cert = await cfService.issueCertificate(mtlsSettings.certLifetimeDays);
  } catch (err) {
    console.error('[agents] mTLS cert issuance failed, falling back to bearer-only auth:', err);
    return null;
  }

  try {
    await db
      .update(devices)
      .set({
        mtlsCertSerialNumber: cert.serialNumber,
        mtlsCertExpiresAt: new Date(cert.expiresOn),
        mtlsCertIssuedAt: new Date(cert.issuedOn),
        mtlsCertCfId: cert.id,
      })
      .where(eq(devices.id, deviceId));
  } catch (dbErr) {
    console.error('[agents] mTLS cert issued but DB update failed — orphaned cert on Cloudflare:', {
      deviceId, cfCertId: cert.id, error: dbErr,
    });
  }

  return {
    certificate: cert.certificate,
    privateKey: cert.privateKey,
    expiresAt: cert.expiresOn,
    serialNumber: cert.serialNumber,
  };
}
