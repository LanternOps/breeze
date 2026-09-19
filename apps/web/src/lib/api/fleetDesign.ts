// Typed fetch wrappers for the Fleet Design apply/rollback API (Fleet
// Designer W03, #5653), mounted under `/ai/fleet-design`.
//
// Same idiom as devices.ts: no generic api client, every wrapper calls the
// ambient `fetchWithAuth` and either returns the raw Response (mutations,
// so callers wrap them in `runAction`) or a parsed, typed body (reads). None
// of these routes use a `{ data }` envelope — see routes/fleetDesign.ts.
import type { FleetDesignApproval, FleetDesignApplyPreview, FleetDesignApplyResult, FleetDesignDrift, FleetDesignLedgerItem, FleetDesignOutcome, FleetDesignRollbackResult, FleetDesignerSetup } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

export interface FleetDesignListItem {
  reportRunId: string;
  reportId: string;
  orgId: string;
  generatedAt: string | null;
  runId: string | null;
  functionCount: number;
  watchCount: number;
  ruleCount: number;
  evidenceTruncated: boolean;
}

/** `report_runs.result.summary.fleetDesign` (partial fields — see the shared type's docstring). */
export interface FleetDesignSummary {
  fleetDesign?: { outcome?: FleetDesignOutcome; drift?: FleetDesignDrift | null; [key: string]: unknown };
}

export interface FleetDesignDetail {
  reportRunId: string;
  reportId: string;
  orgId: string;
  summary: FleetDesignSummary;
  markdown: string;
  downloadPath: string;
}

const base = (reportRunId: string) => `/ai/fleet-design/${encodeURIComponent(reportRunId)}`;

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`fleet_design_request_failed_${res.status}`);
  return (await res.json()) as T;
}

export async function listDesigns(orgId: string): Promise<FleetDesignListItem[]> {
  const res = await fetchWithAuth(`/ai/fleet-design?orgId=${encodeURIComponent(orgId)}`);
  const body = await parseJson<{ items: FleetDesignListItem[] }>(res);
  return body.items;
}

export async function getDesign(reportRunId: string): Promise<FleetDesignDetail> {
  return parseJson<FleetDesignDetail>(await fetchWithAuth(base(reportRunId)));
}

export async function listApplied(reportRunId: string): Promise<FleetDesignLedgerItem[]> {
  const body = await parseJson<{ items: FleetDesignLedgerItem[] }>(
    await fetchWithAuth(`${base(reportRunId)}/applied`),
  );
  return body.items;
}

/** GET /ai/fleet-design/designer — is there a runnable designer agent for
 *  this org, and can THIS user fix it with one click (#6214)? Wrapped in a
 *  `{ data }` envelope, unlike the report routes. */
export async function getDesignerSetup(orgId: string): Promise<FleetDesignerSetup> {
  const body = await parseJson<{ data: FleetDesignerSetup }>(
    await fetchWithAuth(`/ai/fleet-design/designer?orgId=${encodeURIComponent(orgId)}`),
  );
  return body.data;
}

/** POST /ai/fleet-design/designer/enable — raw Response; wrap in runAction.
 *  Creates the partner's designer agent in act (or turns an existing one on). */
export function enableDesigner(orgId: string): Promise<Response> {
  return fetchWithAuth('/ai/fleet-design/designer/enable', {
    method: 'POST',
    body: JSON.stringify({ orgId }),
  });
}

/** POST /ai/fleet-design/runs — raw Response; wrap in runAction (202/200-skip/error). */
export function startDesignRun(orgId: string, siteId?: string | null): Promise<Response> {
  return fetchWithAuth('/ai/fleet-design/runs', {
    method: 'POST',
    body: JSON.stringify({ orgId, ...(siteId ? { siteId } : {}) }),
  });
}

/** POST .../apply/preview — raw Response; parse via runAction's parseSuccess. */
export function previewApply(reportRunId: string, approval: FleetDesignApproval): Promise<Response> {
  return fetchWithAuth(`${base(reportRunId)}/apply/preview`, {
    method: 'POST',
    body: JSON.stringify(approval),
  });
}

/** POST .../apply — raw Response; 409 `{error:'blocked',blockers,unaccepted}` / 403 `{error:'site_restricted'}`. */
export function apply(reportRunId: string, approval: FleetDesignApproval): Promise<Response> {
  return fetchWithAuth(`${base(reportRunId)}/apply`, {
    method: 'POST',
    body: JSON.stringify(approval),
  });
}

/** POST .../rollback — raw Response. */
export function rollback(reportRunId: string): Promise<Response> {
  return fetchWithAuth(`${base(reportRunId)}/rollback`, { method: 'POST' });
}

export interface FleetDesignFiledDocument {
  documentId: string;
  alreadyFiled: boolean;
  evidence: { deliverableId: string; occurrenceId: string } | null;
}

/** POST .../document (W05) — files the design PDF in the org's document library; raw Response. */
export function fileAsDocument(reportRunId: string): Promise<Response> {
  return fetchWithAuth(`${base(reportRunId)}/document`, { method: 'POST' });
}

export type { FleetDesignApproval, FleetDesignApplyPreview, FleetDesignApplyResult, FleetDesignLedgerItem, FleetDesignRollbackResult };
