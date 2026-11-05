import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { db } from '../../db';
import { edrTenants } from '../../db/schema';
import { decryptEdrSecret, encryptEdrSecret } from './credentials';
import type { EdrInstallerProviderKey } from './providerKeys';
import type { EdrInstallerFetchErrorCode } from './types';
import { captureException } from '../sentry';

/**
 * The ONLY module that names `edr_tenants.installer_secret_encrypted`
 * (installerMaterial.writer.contract.test.ts). A per-company installer link is
 * a secret: it never reaches a route, a log, an error, an audit row or an AI tool.
 */

export const INSTALLER_REFRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const INSTALLER_EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;
/**
 * Fetches per inventory run. With GravityZone's 10/min budget this bounds what an
 * MSP with hundreds of companies adds to one run to about three minutes.
 */
export const INSTALLER_FETCH_MAX_PER_RUN = 30;

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

/**
 * Status columns for the sync job's Phase 1. A boolean instead of the ciphertext:
 * Phase 2 never needs it. A function, like the one below, because this module is in
 * softwareDeployment's import closure and many suites mock the schema partially.
 */
export function installerStateSelect() {
  return {
    installerHasMaterial: sql<boolean>`(${edrTenants.installerSecretEncrypted} IS NOT NULL AND ${edrTenants.installerSecretEncrypted} <> '')`,
    installerFetchedAt: edrTenants.installerFetchedAt,
    installerExpiresAt: edrTenants.installerExpiresAt,
    installerFetchError: edrTenants.installerFetchError,
  };
}

/** For installer-tenant selection only. Readiness callers must not receive the ciphertext. */
export function installerSealedSelect() {
  return {
    sealedMaterial: edrTenants.installerSecretEncrypted,
  };
}

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

/**
 * The tenants to fetch this run. A random subset rather than the first N: there
 * is no per-tenant attempt time to order by, and a fixed order would let tenants
 * that always fail starve the rest of the list.
 */
export function pickInstallerFetches<T>(due: readonly T[], random: () => number = Math.random): T[] {
  const pool = [...due];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, INSTALLER_FETCH_MAX_PER_RUN);
}

export type InstallerOutcome = { tenantId: string } & (
  | { ok: true; data: unknown; expiresAt: Date | null }
  | { ok: false; code: EdrInstallerFetchErrorCode }
);

type DbExecutor = Pick<typeof db, 'update'>;

/**
 * What each fetch error does to the stored link. A Record, so a new code cannot
 * be added without deciding. `retire`: the vendor answered and the answer means
 * the stored link can no longer be trusted (the package is gone, there are now
 * several, the key lost the Packages API, or the link offered is one Breeze
 * refuses); dispatching the old link would ignore that, and with no expiry
 * nothing else would retire it. `keep`: no answer, so a link that still works stays.
 */
const ON_FETCH_ERROR: Readonly<Record<EdrInstallerFetchErrorCode, 'retire' | 'keep'>> = {
  no_package: 'retire',
  multiple_packages: 'retire',
  url_rejected: 'retire',
  malformed_response: 'retire',
  packages_api_disabled: 'retire',
  vendor_error: 'keep',
};

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
    if (outcome.ok && outcome.data === undefined) {
      // An adapter bug, not a link: sealing it would leave a tenant that looks ready and never opens.
      values = { ...CLEARED_MATERIAL, installerFetchError: 'malformed_response' };
    } else if (outcome.ok) {
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
      } catch (error) {
        // The class only: the message of a crypto failure could quote the plaintext.
        const kind = error instanceof Error ? error.name : typeof error;
        console.error(`[edr:installer] could not seal installer material for tenant ${outcome.tenantId} (${kind})`);
        captureException(new Error(`EDR installer material could not be sealed (${kind})`));
        values = { installerFetchError: 'vendor_error' };
      }
    } else {
      values = ON_FETCH_ERROR[outcome.code] === 'retire'
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
