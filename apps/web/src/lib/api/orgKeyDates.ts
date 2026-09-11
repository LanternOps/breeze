// Typed fetch wrappers for the Organization Key Dates API (feature #5573 W01),
// mounted under the org router at /orgs/:orgId/key-dates.
//
// Takes the fetcher as a parameter for the same reason serviceDeliverables.ts
// does: the org record pins requests with `makeOrgFetch` while other pages use
// the ambient `fetchWithAuth`. Every route responds with a `{ data }` envelope.

import type { CreateKeyDateInput, UpdateKeyDateInput } from '@breeze/shared';

import { unwrapData, type Fetcher } from './serviceDeliverables';

export type { Fetcher };

export type KeyDateKind =
  | 'insurance_renewal'
  | 'vendor_contract_end'
  | 'compliance_deadline'
  | 'audit'
  | 'other';

/** A row of the merged key-date list (`KeyDateView`): stored `org_key_dates`
 *  rows plus one synthesized `contract_end` entry per active contract with an
 *  end date. Only `key_date` rows can be edited or deleted. */
export interface KeyDate {
  source: 'key_date' | 'contract_end';
  id: string;
  label: string;
  kind: KeyDateKind;
  date: string;
  recursAnnually: boolean;
  remindDaysBefore: number | null;
  ownerUserId: string | null;
  portalVisible: boolean;
  notes: string | null;
  contractId: string | null;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function base(orgId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/key-dates`;
}


export async function listKeyDates(f: Fetcher, orgId: string): Promise<KeyDate[]> {
  return unwrapData<KeyDate[]>(await f(base(orgId)));
}

export async function createKeyDate(
  f: Fetcher,
  orgId: string,
  body: CreateKeyDateInput,
): Promise<KeyDate> {
  return unwrapData<KeyDate>(
    await f(base(orgId), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }),
  );
}

export async function updateKeyDate(
  f: Fetcher,
  orgId: string,
  id: string,
  body: UpdateKeyDateInput,
): Promise<KeyDate> {
  return unwrapData<KeyDate>(
    await f(`${base(orgId)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
  );
}

export async function deleteKeyDate(f: Fetcher, orgId: string, id: string): Promise<void> {
  await unwrapData<unknown>(await f(`${base(orgId)}/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}
