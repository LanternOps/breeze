// Typed fetch wrappers for the Ticket Checklist Template API (feature #5808
// W02), mounted at `/ticket-checklist-templates`.
//
// Same idiom as ticketChecklist.ts: no generic apiClient, every route responds
// with a `{ data: ... }` envelope, and `unwrapData`/`Fetcher` come from
// serviceDeliverables.ts rather than being re-implemented.
//
// A template is org-owned OR partner-wide (`orgId === null`). `ownerScope` is
// CREATE-ONLY — the API rejects it on PATCH with a 400, because re-homing a
// template across the ownership axis would hand one org's private procedure to
// every org under the partner (or the reverse).

import type {
  CreateChecklistTemplateInput,
  UpdateChecklistTemplateInput,
  CreateChecklistTemplateItemInput,
  UpdateChecklistTemplateItemInput,
} from '@breeze/shared';
import { unwrapData, type Fetcher } from './serviceDeliverables';

export type { Fetcher };

export interface ChecklistTemplateItem {
  id: string;
  templateId: string;
  label: string;
  detail: string | null;
  sortOrder: number;
}

export interface ChecklistTemplate {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  ownerScope: 'organization' | 'partner';
  name: string;
  description: string | null;
  /** Internal runbook prose. Never rendered in the customer portal (spec §5). */
  instructions: string | null;
  isActive: boolean;
  items: ChecklistTemplateItem[];
  createdAt: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const BASE = '/ticket-checklist-templates';

const templatePath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const itemPath = (itemId: string) => `${BASE}/items/${encodeURIComponent(itemId)}`;

function jsonInit(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export async function listChecklistTemplates(
  f: Fetcher,
  opts: { includeInactive?: boolean } = {},
): Promise<ChecklistTemplate[]> {
  const qs = opts.includeInactive ? '?includeInactive=true' : '';
  return unwrapData<ChecklistTemplate[]>(await f(`${BASE}${qs}`));
}

export async function createChecklistTemplate(
  f: Fetcher,
  body: CreateChecklistTemplateInput,
): Promise<ChecklistTemplate> {
  return unwrapData<ChecklistTemplate>(await f(BASE, jsonInit('POST', body)));
}

export async function updateChecklistTemplate(
  f: Fetcher,
  id: string,
  body: UpdateChecklistTemplateInput,
): Promise<ChecklistTemplate> {
  return unwrapData<ChecklistTemplate>(await f(templatePath(id), jsonInit('PATCH', body)));
}

export async function deleteChecklistTemplate(f: Fetcher, id: string): Promise<void> {
  await unwrapData<unknown>(await f(templatePath(id), { method: 'DELETE' }));
}

export async function addChecklistTemplateItem(
  f: Fetcher,
  templateId: string,
  body: CreateChecklistTemplateItemInput,
): Promise<ChecklistTemplateItem> {
  return unwrapData<ChecklistTemplateItem>(
    await f(`${templatePath(templateId)}/items`, jsonInit('POST', body)),
  );
}

export async function updateChecklistTemplateItem(
  f: Fetcher,
  itemId: string,
  body: UpdateChecklistTemplateItemInput,
): Promise<ChecklistTemplateItem> {
  return unwrapData<ChecklistTemplateItem>(await f(itemPath(itemId), jsonInit('PATCH', body)));
}

export async function removeChecklistTemplateItem(f: Fetcher, itemId: string): Promise<void> {
  await unwrapData<unknown>(await f(itemPath(itemId), { method: 'DELETE' }));
}

/** The COMPLETE ordered id list for the template — a partial list is a 400. */
export async function reorderChecklistTemplateItems(
  f: Fetcher,
  templateId: string,
  itemIds: string[],
): Promise<ChecklistTemplateItem[]> {
  return unwrapData<ChecklistTemplateItem[]>(
    await f(`${templatePath(templateId)}/items/reorder`, jsonInit('POST', { itemIds })),
  );
}
