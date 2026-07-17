// Typed fetch wrappers for the Contract Template library API (Task 9 routes,
// mounted under the contracts router at /contracts/contract-templates).
//
// Same idiom as contracts.ts / the invoice web layer: there is no generic
// apiClient — every call goes through fetchWithAuth (apps/web/src/stores/auth.ts),
// which injects the active orgId, refreshes tokens, and returns a raw Response.
// Callers keep full control over 401 handling and wrap mutations in runAction.
// Every route responds with a `{ data: ... }` envelope.

import { fetchWithAuth } from '../../stores/auth';
import { AUTO_CONTRACT_VARIABLES, type ContractVariable } from '@breeze/shared';

export type { ContractVariable };
export { AUTO_CONTRACT_VARIABLES };

const BASE = '/contracts/contract-templates';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export type ContractTemplateStatus = 'active' | 'archived';
export type TemplateVersionStatus = 'draft' | 'published';
export type TemplateSourceType = 'authored' | 'uploaded';
export type TemplateOwnerScope = 'organization' | 'partner';

/** A `contract_templates` row as returned by the API. */
export interface ContractTemplate {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  description: string | null;
  status: ContractTemplateStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A version row minus the binary `fileData` column (stripped server-side). */
export interface TemplateVersionSummary {
  id: string;
  templateId: string;
  orgId: string | null;
  partnerId: string | null;
  versionNumber: number;
  status: TemplateVersionStatus;
  sourceType: TemplateSourceType;
  bodyHtml: string | null;
  mime: string | null;
  byteSize: number | null;
  sha256: string | null;
  declaredVariables: ContractVariable[];
  publishedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** A row from `GET /` — the list shape, with a `latestVersion` summary. */
export interface ContractTemplateWithLatest extends ContractTemplate {
  latestVersion: TemplateVersionSummary | null;
}

/** `GET /:id` — the template plus every version, newest first. */
export interface ContractTemplateDetail extends ContractTemplate {
  versions: TemplateVersionSummary[];
}

export interface CreateContractTemplateBody {
  name: string;
  description?: string;
  ownerScope: TemplateOwnerScope;
  orgId?: string;
}

// ---- requests -------------------------------------------------------------

export function listContractTemplates(opts: { includeArchived?: boolean } = {}): Promise<Response> {
  const qs = opts.includeArchived ? '?includeArchived=true' : '';
  return fetchWithAuth(`${BASE}${qs}`);
}

export function getContractTemplate(id: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}`);
}

export function createContractTemplate(body: CreateContractTemplateBody): Promise<Response> {
  return fetchWithAuth(BASE, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function updateContractTemplate(id: string, body: { name?: string; description?: string }): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function archiveContractTemplate(id: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}/archive`, { method: 'POST' });
}

export function createTemplateVersion(id: string, body: { bodyHtml: string }): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}/versions`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Upload a PDF as a new draft version. The browser sets the multipart
 *  boundary Content-Type header itself — do NOT set it manually. */
export function uploadTemplateVersion(id: string, file: File): Promise<Response> {
  const form = new FormData();
  form.append('file', file);
  return fetchWithAuth(`${BASE}/${id}/versions/upload`, { method: 'POST', body: form });
}

export function publishTemplateVersion(id: string, versionId: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}/versions/${versionId}/publish`, { method: 'POST' });
}

export function getTemplateVersion(id: string, versionId: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}/versions/${versionId}`);
}

/** Streams the uploaded PDF's raw bytes (200) or 404 for an authored version. */
export function getTemplateVersionFile(id: string, versionId: string): Promise<Response> {
  return fetchWithAuth(`${BASE}/${id}/versions/${versionId}/file`);
}

// ---- variable helpers -----------------------------------------------------

// Same token pattern the server scans (VARIABLE_TOKEN_RE) — a token that would
// not validate as a variable name is not detected as one.
const VARIABLE_TOKEN_RE = /\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g;
const AUTO_SET = new Set<string>(AUTO_CONTRACT_VARIABLES);

/** Scan `{{ name }}` tokens out of a body, deduped, classified auto/manual. */
export function detectVariables(html: string): ContractVariable[] {
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  VARIABLE_TOKEN_RE.lastIndex = 0;
  while ((match = VARIABLE_TOKEN_RE.exec(html)) !== null) names.add(match[1]!);
  return [...names].map((name) => ({ name, kind: AUTO_SET.has(name) ? 'auto' : 'manual' }));
}

/** Manual (non-auto) variable names detected live in a body. */
export function detectManualVariables(html: string): string[] {
  return detectVariables(html)
    .filter((v) => v.kind === 'manual')
    .map((v) => v.name);
}

export function isAutoVariable(name: string): boolean {
  return AUTO_SET.has(name);
}
