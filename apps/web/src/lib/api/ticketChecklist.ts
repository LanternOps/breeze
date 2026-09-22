// Typed fetch wrappers for the Ticket Checklist API (feature #5808 W01),
// mounted under the ticket router (checklist.ts): reads live at
// `/tickets/:ticketId/checklist`, item mutations at `/tickets/checklist/:itemId`
// (a separate item-id-keyed path — the item alone carries no tenancy, so the
// API re-derives it from the item's own ticket).
//
// Same idiom as serviceDeliverables.ts: no generic apiClient, every route
// responds with a `{ data: ... }` envelope. `unwrapData` and the `Fetcher`
// type are imported from there rather than re-implemented — this module is
// internal-only (never org-pinned, see checklist.ts's comment on requireScope
// `partner`/`system`), so callers pass the ambient `fetchWithAuth`.

import type {
  ChecklistItemCreateInput,
  ChecklistItemPatchInput,
  ChecklistItemSource,
  ApplyChecklistTemplateInput,
} from '@breeze/shared';
import { unwrapData, type Fetcher } from './serviceDeliverables';

export type { Fetcher };

export interface ChecklistItem {
  id: string;
  ticketId: string;
  label: string;
  detail: string | null;
  position: number;
  done: boolean;
  doneAt: string | null;
  doneByUserId: string | null;
  source: ChecklistItemSource;
  sourceTemplateItemId: string | null;
  /**
   * The AI Operator task behind a `source: 'operator_task'` item.
   *
   * Null when the server could not resolve the step in this item's org — which
   * is what a ticket moved between orgs looks like. The badge renders either
   * way; only the link is conditional, because a link built from a null id
   * would navigate to `/operator/tasks/null`.
   */
  operatorTaskId: string | null;
  createdAt: string;
}

export interface ChecklistSummary {
  items: ChecklistItem[];
  done: number;
  total: number;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function ticketPath(ticketId: string): string {
  return `/tickets/${encodeURIComponent(ticketId)}/checklist`;
}

function itemPath(itemId: string): string {
  return `/tickets/checklist/${encodeURIComponent(itemId)}`;
}

function jsonInit(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export async function listChecklist(f: Fetcher, ticketId: string): Promise<ChecklistSummary> {
  return unwrapData<ChecklistSummary>(await f(ticketPath(ticketId)));
}

export async function addChecklistItem(
  f: Fetcher,
  ticketId: string,
  body: ChecklistItemCreateInput,
): Promise<ChecklistItem> {
  return unwrapData<ChecklistItem>(await f(ticketPath(ticketId), jsonInit('POST', body)));
}

/** The COMPLETE ordered id list for the ticket — a partial list is a 400
 *  (`CHECKLIST_REORDER_MISMATCH`, see checklistReorderSchema). */
export async function reorderChecklist(
  f: Fetcher,
  ticketId: string,
  itemIds: string[],
): Promise<ChecklistSummary> {
  return unwrapData<ChecklistSummary>(
    await f(`${ticketPath(ticketId)}/reorder`, jsonInit('POST', { itemIds })),
  );
}

export async function patchChecklistItem(
  f: Fetcher,
  itemId: string,
  body: ChecklistItemPatchInput,
): Promise<ChecklistItem> {
  return unwrapData<ChecklistItem>(await f(itemPath(itemId), jsonInit('PATCH', body)));
}

export async function deleteChecklistItem(f: Fetcher, itemId: string): Promise<void> {
  await unwrapData<unknown>(await f(itemPath(itemId), { method: 'DELETE' }));
}

/**
 * Copy a checklist template's steps onto this ticket (#5808 W02).
 *
 * `append` adds after whatever is already there; `replace_unticked` drops the
 * unticked steps first. There is deliberately no destructive mode — a ticked
 * step is a human attestation and is never dropped by applying a template.
 */
export async function applyChecklistTemplate(
  f: Fetcher,
  ticketId: string,
  body: ApplyChecklistTemplateInput,
): Promise<ChecklistSummary> {
  return unwrapData<ChecklistSummary>(
    await f(`${ticketPath(ticketId)}/apply-template`, jsonInit('POST', body)),
  );
}
