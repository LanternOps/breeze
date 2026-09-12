// Typed fetch wrappers for the Deliverable Templates API (feature #5573 W05),
// mounted under `/deliverable-templates` (sets + items) and, for applying a
// set to an organization, under the org router at
// `/orgs/:orgId/deliverables/apply-template`.
//
// Same idiom as serviceDeliverables.ts: no generic apiClient, every route
// responds with a `{ data: ... }` envelope, `unwrapData` throws an
// `ActionError` carrying the parsed body so callers can wrap mutations in
// runAction (via runClientAction) and read `.code` / `.body.details` for
// collision handling. The fetcher is a PARAMETER, not an ambient
// `fetchWithAuth` import — the settings page uses the ambient fetch while a
// caller opened from the org record must stay pinned to that org via
// `OrgFetch` (orgRecordFetch.ts), and both share this one client.

import type {
  ApplyTemplateSetInput,
  CreateTemplateItemInput,
  CreateTemplateSetInput,
  UpdateTemplateItemInput,
  UpdateTemplateSetInput,
} from '@breeze/shared';
import { unwrapData, type DeliverableCadence, type Fetcher } from './serviceDeliverables';

export type { Fetcher };

export interface TemplateItem {
  id: string;
  setId: string;
  name: string;
  description: string | null;
  cadence: DeliverableCadence;
  leadDays: number;
  graceDays: number;
  artifactRequired: boolean;
  completionMode: 'explicit' | 'on_ticket_resolve';
  sortOrder: number;
}

export interface TemplateSet {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  ownerScope: 'organization' | 'partner';
  name: string;
  description: string | null;
  items: TemplateItem[];
  createdAt: string;
  updatedAt: string;
}

export interface ApplyTemplateResult {
  setId: string;
  setName: string;
  orgId: string;
  contractId: string | null;
  effectiveFrom: string;
  created: Array<{ id: string; name: string; cadence: DeliverableCadence; anchorDueDate: string }>;
  skipped: string[];
}

export interface ListTemplateSetsQuery {
  orgId?: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const BASE = '/deliverable-templates';

function setPath(setId: string): string {
  return `${BASE}/${encodeURIComponent(setId)}`;
}

function itemPath(setId: string, itemId: string): string {
  return `${setPath(setId)}/items/${encodeURIComponent(itemId)}`;
}

function jsonInit(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export async function listTemplateSets(f: Fetcher, q: ListTemplateSetsQuery = {}): Promise<TemplateSet[]> {
  const params = new URLSearchParams();
  if (q.orgId) params.set('orgId', q.orgId);
  const qs = params.toString();
  return unwrapData<TemplateSet[]>(await f(`${BASE}${qs ? `?${qs}` : ''}`));
}

export async function createTemplateSet(f: Fetcher, body: CreateTemplateSetInput): Promise<TemplateSet> {
  return unwrapData<TemplateSet>(await f(BASE, jsonInit('POST', body)));
}

export async function updateTemplateSet(
  f: Fetcher,
  setId: string,
  body: UpdateTemplateSetInput,
): Promise<TemplateSet> {
  return unwrapData<TemplateSet>(await f(setPath(setId), jsonInit('PATCH', body)));
}

export async function deleteTemplateSet(f: Fetcher, setId: string): Promise<void> {
  await unwrapData<unknown>(await f(setPath(setId), { method: 'DELETE' }));
}

export async function addTemplateItem(
  f: Fetcher,
  setId: string,
  body: CreateTemplateItemInput,
): Promise<TemplateItem> {
  return unwrapData<TemplateItem>(await f(`${setPath(setId)}/items`, jsonInit('POST', body)));
}

export async function updateTemplateItem(
  f: Fetcher,
  setId: string,
  itemId: string,
  body: UpdateTemplateItemInput,
): Promise<TemplateItem> {
  return unwrapData<TemplateItem>(await f(itemPath(setId, itemId), jsonInit('PATCH', body)));
}

export async function removeTemplateItem(f: Fetcher, setId: string, itemId: string): Promise<void> {
  await unwrapData<unknown>(await f(itemPath(setId, itemId), { method: 'DELETE' }));
}

export async function applyTemplateSet(
  f: Fetcher,
  orgId: string,
  body: ApplyTemplateSetInput,
): Promise<ApplyTemplateResult> {
  return unwrapData<ApplyTemplateResult>(
    await f(`/orgs/${encodeURIComponent(orgId)}/deliverables/apply-template`, jsonInit('POST', body)),
  );
}
