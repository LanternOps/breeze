import type { z } from 'zod';
import type { ExternalBackupStatus } from '@breeze/shared';

/**
 * A customer/tenant discovered in the vendor console, flattened out of
 * whatever tree shape the vendor uses.
 */
export interface VendorCustomer {
  vendorCustomerId: string;
  name: string;
  parentId: string | null;
  /** The vendor's own level/tier string, stored as-is for display. */
  level: string | null;
  /** The vendor's free-text external reference; auto-mapping tries to read a Breeze org id out of it. */
  externalCode: string | null;
}

/**
 * One device/endpoint as the vendor reports it. Deliberately flat and
 * vendor-neutral: every field either maps onto a `backup_provider_devices`
 * column or is dropped. `raw` carries the vendor's own payload for debugging
 * and for columns we have not promoted yet.
 */
export interface VendorDevice {
  vendorDeviceId: string;
  vendorCustomerId: string;
  name: string;
  computerName: string | null;
  osType: 'workstation' | 'server' | 'unknown';
  osVersion: string | null;
  clientVersion: string | null;
  /** Lower-case, colon-separated, de-duplicated. */
  macAddresses: string[];
  accountType: 'backup_manager' | 'm365' | 'unknown';
  /** Normalized source names: files, system_state, mssql, hyperv, vmware, m365_*, bare_metal, … */
  dataSources: string[];
  status: ExternalBackupStatus;
  /** The vendor's own status code, kept so an `unknown` mapping can be diagnosed. */
  vendorStatusCode: number | null;
  lastSessionAt: Date | null;
  lastSuccessAt: Date | null;
  lastCompletedAt: Date | null;
  selectedBytes: number | null;
  usedBytes: number | null;
  errorsCount: number;
  vendorCreatedAt: Date | null;
  vendorExpiresAt: Date | null;
  raw: Record<string, unknown>;
}

/**
 * A vendor API call failed.
 *
 * `reauth` is the load-bearing field: it separates "this credential is dead or
 * lacks permission" (stop retrying, mark the connection `reauth_required`, make
 * the MSP re-enter it) from "this call failed" (retry with backoff). Conflating
 * them either spams a dead connection forever or disables a healthy one on a
 * transient 500 — so an adapter must set it from the vendor's OWN signal (which
 * call failed, and its error code), never from a message substring alone.
 */
export class ProviderRequestError extends Error {
  readonly code: string;
  readonly reauth: boolean;

  constructor(message: string, options: { code: string; reauth: boolean; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ProviderRequestError';
    this.code = options.code;
    this.reauth = options.reauth;
  }
}

export type ProviderTestResult =
  | { ok: true; rootId: string; rootName: string; customerCount: number }
  | { ok: false; error: string; reauth: boolean };

/**
 * The whole vendor boundary. A second vendor is a new file implementing this
 * and one line in `registry.ts` — nothing above this interface knows Cove
 * exists.
 *
 * `listDevices` must be ALL-OR-NOTHING: it returns only when every page
 * succeeded, and throws `ProviderRequestError` otherwise. The sync job deletes
 * rows whose vendor device vanished, so a partial enumeration that looked like
 * a success would silently delete a customer's whole backup inventory.
 */
export interface BackupProviderAdapter {
  readonly key: string;
  readonly label: string;
  /** Validates the credential blob BEFORE it is encrypted and stored. */
  readonly credentialsSchema: z.ZodTypeAny;
  testConnection(creds: unknown, baseUrl: string): Promise<ProviderTestResult>;
  /** The whole subtree under `rootId`, flattened. */
  listCustomers(creds: unknown, baseUrl: string, rootId: string): Promise<VendorCustomer[]>;
  /** The whole subtree under `rootId`. Throws `ProviderRequestError` if ANY page fails. */
  listDevices(creds: unknown, baseUrl: string, rootId: string): Promise<VendorDevice[]>;
}
