/**
 * Tenant variables (#3409) — API surface types shared by the web dashboard and
 * the API routes.
 */

export type TenantVariableOwnerScope = 'organization' | 'partner';

/**
 * A tenant variable as returned by the API.
 *
 * `value` is null for `isSecret` rows: secret values are write-only in v1 —
 * there is no reveal endpoint and no query parameter that returns them. A
 * non-secret variable returns its plaintext, which is the whole point of
 * marking it non-secret.
 */
export interface TenantVariable {
  id: string;
  key: string;
  value: string | null;
  isSecret: boolean;
  description: string | null;
  ownerScope: TenantVariableOwnerScope;
  orgId: string | null;
  partnerId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
