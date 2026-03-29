import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db';
import { incidents, type IncidentTimelineEntry } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import {
  ALLOWED_EVIDENCE_STORAGE_SCHEMES,
  ALLOWED_STATUS_TRANSITIONS,
  listIncidentsSchema,
  type IncidentActionStatus,
  type IncidentStatus,
} from './incidents.validation';

export function canTransitionStatus(
  from: IncidentStatus,
  to: IncidentStatus
): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

export function asTimeline(value: unknown): IncidentTimelineEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as IncidentTimelineEntry[];
}

export function appendTimeline(
  current: unknown,
  entry: IncidentTimelineEntry
): IncidentTimelineEntry[] {
  const timeline = asTimeline(current);
  return [...timeline, entry];
}

export function normalizeTimelineWithSort(value: unknown): IncidentTimelineEntry[] {
  const timeline = asTimeline(value);
  return [...timeline].sort((a, b) => a.at.localeCompare(b.at));
}

export function isControlledEvidenceStoragePath(storagePath: string): boolean {
  if (storagePath.includes('..')) {
    return false;
  }

  const match = storagePath.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!match) {
    return false;
  }

  const scheme = (match[1] ?? '').toLowerCase();
  return ALLOWED_EVIDENCE_STORAGE_SCHEMES.has(scheme);
}

export function computeSha256FromBase64(contentBase64: string): string {
  const trimmed = contentBase64.replace(/\s+/g, '');
  if (trimmed.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error('Invalid base64 content');
  }
  const buffer = Buffer.from(trimmed, 'base64');
  if (buffer.length === 0) {
    throw new Error('Invalid base64 content');
  }
  return createHash('sha256').update(buffer).digest('hex');
}

export function isContainmentSuccess(status: IncidentActionStatus): boolean {
  return status === 'completed';
}

export function getPagination(query: z.infer<typeof listIncidentsSchema>): { page: number; limit: number; offset: number } {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export function resolveOrgFilter(
  auth: AuthContext,
  queryOrgId: string | undefined,
  column: PgColumn
): { condition?: SQL; error?: { message: string; status: number } } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: { message: 'Organization context required', status: 403 } };
    }
    if (queryOrgId && queryOrgId !== auth.orgId) {
      return { error: { message: 'Access to this organization denied', status: 403 } };
    }
    return { condition: eq(column, auth.orgId) };
  }

  if (auth.scope === 'partner') {
    if (queryOrgId) {
      if (!auth.canAccessOrg(queryOrgId)) {
        return { error: { message: 'Access to this organization denied', status: 403 } };
      }
      return { condition: eq(column, queryOrgId) };
    }

    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) {
      return { condition: eq(column, '00000000-0000-0000-0000-000000000000') };
    }
    return { condition: inArray(column, orgIds) };
  }

  if (auth.scope === 'system' && queryOrgId) {
    return { condition: eq(column, queryOrgId) };
  }

  return {};
}

export async function getIncidentWithOrgCheck(incidentId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(incidents.id, incidentId)];
  const orgCondition = auth.orgCondition(incidents.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  const [incident] = await db
    .select()
    .from(incidents)
    .where(and(...conditions))
    .limit(1);

  return incident ?? null;
}
