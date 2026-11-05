import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { db } from '../../db';
import { edrTenants } from '../../db/schema';
import { decryptEdrSecret, encryptEdrSecret } from './credentials';
import type { EdrInstallerProviderKey } from './providerKeys';
import type { EdrInstallerFetchErrorCode } from './types';

/**
 * The ONLY module that names `edr_tenants.installer_secret_encrypted`
 * (installerMaterial.writer.contract.test.ts). A per-company installer link is
 * a secret: it never reaches a route, a log, an error, an audit row or an AI tool.
 */

export const INSTALLER_REFRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const INSTALLER_EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;

/** The sealed plaintext. `data` is adapter-owned; `buildInstaller` validates it. */
export interface InstallerMaterialEnvelope {
  v: 1;
  provider: string;
  fetchedAt: string;
  expiresAt: string | null;
  data: unknown;
}

export const installerMaterialEnvelopeSchema = z.object({
  v: z.literal(1),
  provider: z.string().min(1),
  fetchedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  // z.unknown() would admit a missing key; a sealed envelope always carries it.
  data: z.custom<unknown>((value) => value !== undefined),
}).strict() as unknown as z.ZodType<InstallerMaterialEnvelope>;

export function sealInstallerMaterial(tenantId: string, envelope: InstallerMaterialEnvelope): string {
  return encryptEdrSecret('tenant_installer_secret', tenantId, envelope);
}

/** Null on a decrypt or schema failure. Never throws and never logs: the caller refuses to dispatch. */
export function openInstallerMaterial(tenantId: string, ciphertext: string): InstallerMaterialEnvelope | null {
  try {
    const parsed = installerMaterialEnvelopeSchema.safeParse(
      decryptEdrSecret('tenant_installer_secret', tenantId, ciphertext),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Status columns for the sync job's Phase 1. A boolean instead of the ciphertext: Phase 2 never needs it. */
export const INSTALLER_STATE_SELECT = {
  installerHasMaterial: sql<boolean>`(${edrTenants.installerSecretEncrypted} IS NOT NULL AND ${edrTenants.installerSecretEncrypted} <> '')`,
  installerFetchedAt: edrTenants.installerFetchedAt,
  installerExpiresAt: edrTenants.installerExpiresAt,
  installerFetchError: edrTenants.installerFetchError,
} as const;

/** For installer-tenant selection only. Readiness callers must not receive the ciphertext. */
export const INSTALLER_SEALED_SELECT = {
  sealedMaterial: edrTenants.installerSecretEncrypted,
  installerExpiresAt: edrTenants.installerExpiresAt,
} as const;

/**
 * Pure. Due when there is no material, its expiry is inside the margin, it is
 * older than the max age, or the last attempt errored (so an error is retried at
 * the inventory cadence). Never due for an unmapped tenant.
 */
export function installerRefreshDue(
  row: { orgId: string | null; hasMaterial: boolean; fetchedAt: Date | null; expiresAt: Date | null; fetchError: string | null },
  now: Date,
): boolean {
  if (!row.orgId) return false;
  if (!row.hasMaterial || !row.fetchedAt || row.fetchError) return true;
  if (row.expiresAt && row.expiresAt.getTime() - now.getTime() <= INSTALLER_EXPIRY_MARGIN_MS) return true;
  return now.getTime() - row.fetchedAt.getTime() > INSTALLER_REFRESH_MAX_AGE_MS;
}

export type InstallerOutcome = { tenantId: string } & (
  | { ok: true; data: unknown; expiresAt: Date | null }
  | { ok: false; code: EdrInstallerFetchErrorCode }
);

type DbExecutor = Pick<typeof db, 'update'>;

/**
 * The vendor answered, and the answer means the stored link can no longer be
 * trusted: the package is gone, there are now several to choose from, or the
 * link it offers is one Breeze refuses. Dispatching the old link would ignore
 * that, and with no expiry nothing else would ever retire it.
 */
const VERDICTS_THAT_RETIRE_MATERIAL: ReadonlySet<EdrInstallerFetchErrorCode> = new Set<EdrInstallerFetchErrorCode>([
  'no_package', 'multiple_packages', 'url_rejected', 'malformed_response',
]);

const CLEARED_MATERIAL = {
  installerSecretEncrypted: null,
  installerFetchedAt: null,
  installerExpiresAt: null,
} as const;

/**
 * Phase 3 of the inventory run. A vendor verdict retires the stored material; a
 * failure to get an answer keeps it, because an outage must not take away a link
 * that still works. An outcome that cannot be sealed is a tenant-level error,
 * because an installer outcome never fails inventory.
 */
export async function persistInstallerOutcomes(
  tx: DbExecutor,
  provider: EdrInstallerProviderKey,
  outcomes: readonly InstallerOutcome[],
  now: Date,
): Promise<void> {
  for (const outcome of outcomes) {
    let values: Partial<typeof edrTenants.$inferInsert>;
    if (outcome.ok) {
      try {
        values = {
          installerSecretEncrypted: sealInstallerMaterial(outcome.tenantId, {
            v: 1,
            provider,
            fetchedAt: now.toISOString(),
            expiresAt: outcome.expiresAt?.toISOString() ?? null,
            data: outcome.data,
          }),
          installerFetchedAt: now,
          installerExpiresAt: outcome.expiresAt,
          installerFetchError: null,
        };
      } catch {
        console.error(`[edr:installer] could not seal installer material for tenant ${outcome.tenantId}`);
        values = { installerFetchError: 'vendor_error' };
      }
    } else {
      values = VERDICTS_THAT_RETIRE_MATERIAL.has(outcome.code)
        ? { ...CLEARED_MATERIAL, installerFetchError: outcome.code }
        : { installerFetchError: outcome.code };
    }
    await tx.update(edrTenants).set({ ...values, updatedAt: now }).where(eq(edrTenants.id, outcome.tenantId));
  }
}

/**
 * Forget a tenant's material: run in the same transaction as the credential or
 * mapping change that invalidates it, so an old link can never be dispatched
 * after the change commits. Returns how many tenants were cleared.
 */
export async function clearTenantInstallerMaterial(
  tx: DbExecutor,
  where: { connectionId: string } | { tenantId: string },
): Promise<number> {
  const rows = await tx
    .update(edrTenants)
    .set({ ...CLEARED_MATERIAL, installerFetchError: null })
    .where('connectionId' in where ? eq(edrTenants.connectionId, where.connectionId) : eq(edrTenants.id, where.tenantId))
    .returning({ id: edrTenants.id });
  return rows.length;
}
