import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  requestLikeFromSnapshot,
  writeAuditEventAsync,
} from '../../services/auditEvents';
import {
  PARTNER_EXPORT_RESOURCES,
  type PartnerExportResource,
} from './schemas';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_AUDIT_DURATION_MS = 24 * 60 * 60 * 1000;
const PARTNER_EXPORT_ROUTE_PREFIX = '/api/v1/partner-api/';

export interface PartnerExportAuditPrincipal {
  partnerServicePrincipalId: string;
  keyId: string;
  partnerId: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    partnerExportAuditManaged: boolean;
  }
}

type AuditResult = 'success' | 'failure' | 'denied';

type PublicError = {
  status: number;
  error: string;
  code: string;
};

function routeResource(path: string): PartnerExportResource | null {
  return PARTNER_EXPORT_RESOURCES.find(
    (resource) => path === `${PARTNER_EXPORT_ROUTE_PREFIX}${resource}`,
  ) ?? null;
}

function isAuditPrincipal(value: unknown): value is PartnerExportAuditPrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const principal = value as Record<string, unknown>;
  return UUID_PATTERN.test(String(principal.partnerServicePrincipalId ?? ''))
    && UUID_PATTERN.test(String(principal.keyId ?? ''))
    && UUID_PATTERN.test(String(principal.partnerId ?? ''));
}

function publicError(error: unknown): PublicError {
  const status = error instanceof HTTPException ? error.status : 500;
  const message = error instanceof HTTPException ? error.message : '';

  if (status === 401 && message === 'Partner API authentication required') {
    return { status, error: 'Partner API authentication required', code: 'partner_api_auth_required' };
  }
  if (status === 401) {
    return { status, error: 'Invalid partner API credentials', code: 'partner_api_invalid_credentials' };
  }
  if (status === 403) {
    return { status, error: 'Partner API scope required', code: 'partner_api_scope_required' };
  }
  if (status === 429) {
    if (message === 'Too many API key authentication attempts') {
      return {
        status,
        error: 'Too many API key authentication attempts',
        code: 'partner_api_auth_rate_limited',
      };
    }
    return { status, error: 'Partner API rate limit exceeded', code: 'partner_api_rate_limited' };
  }
  if (status >= 500) {
    return { status: 500, error: 'Partner export request failed.', code: 'partner_export_failed' };
  }
  return { status, error: 'Partner API request failed.', code: 'partner_api_request_failed' };
}

function resultForStatus(status: number): AuditResult {
  if (status < 400) return 'success';
  if (status === 401 || status === 403 || status === 429) return 'denied';
  return 'failure';
}

async function responseRecordCount(response: Response, status: number): Promise<number> {
  if (status < 200 || status >= 300) return 0;
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) return 0;
  try {
    const value = await response.clone().json() as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    const data = (value as Record<string, unknown>).data;
    return Array.isArray(data) ? Math.min(data.length, 500) : 0;
  } catch {
    return 0;
  }
}

function durationSince(startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  if (!Number.isFinite(elapsed)) return 0;
  return Math.min(Math.max(Math.trunc(elapsed), 0), MAX_AUDIT_DURATION_MS);
}

async function writePartnerExportAudit(
  principal: PartnerExportAuditPrincipal,
  resource: PartnerExportResource,
  status: number,
  recordCount: number,
  durationMs: number,
): Promise<void> {
  const result = resultForStatus(status);
  try {
    // Deliberately omit request headers. The partner export audit contract is
    // an exact bounded metadata allowlist, not a copy of request provenance.
    await writeAuditEventAsync(requestLikeFromSnapshot({}), {
      orgId: null,
      actorType: 'api_key',
      actorId: principal.keyId,
      action: 'partner_api.export',
      resourceType: 'partner_export',
      resourceId: principal.partnerServicePrincipalId,
      result,
      details: {
        partnerServicePrincipalId: principal.partnerServicePrincipalId,
        keyId: principal.keyId,
        partnerId: principal.partnerId,
        route: `GET /api/v1/partner-api/${resource}`,
        resource,
        result,
        schemaVersion: '1',
        recordCount,
        durationMs,
        httpStatus: status,
      },
    });
  } catch {
    // Audit persistence is best-effort and already has its own retry queue.
    // Never log the caught value: it can contain SQL parameters or secrets.
    console.error('Failed to write partner export audit');
  }
}

/**
 * Outer partner-router middleware. It must be registered before auth so this
 * function resumes only after auth's held partner-RLS transaction has closed.
 */
export const partnerExportAuditMiddleware: MiddlewareHandler = async (c, next) => {
  const resource = c.req.method === 'GET' ? routeResource(c.req.path) : null;
  const startedAt = Date.now();
  if (resource) c.set('partnerExportAuditManaged', true);

  await next();

  if (c.error) {
    const safe = publicError(c.error);
    c.res = c.json({ error: safe.error, code: safe.code }, safe.status as 400);
  }

  if (!resource) return;
  const principal = c.get('partnerApiPrincipal') as unknown;
  if (!isAuditPrincipal(principal)) return;

  const status = c.res.status;
  const recordCount = await responseRecordCount(c.res, status);
  await writePartnerExportAudit(
    principal,
    resource,
    status,
    recordCount,
    durationSince(startedAt),
  );
};

export const __testOnly = {
  routeResource,
  resultForStatus,
};
