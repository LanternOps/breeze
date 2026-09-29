/**
 * Candidate catalog (extracted from remediationSuggestions.listCandidates,
 * AI Suggested Fixes W1). Everything a suggestion may reference: visible to the
 * org AND runnable on the device OS. W1 adds the org's PARTNER-WIDE scripts
 * (org_id NULL, partner_id = the org's partner), which the pre-W1 query
 * (`isSystem OR orgId = ctx.orgId`) never returned.
 *
 * Visibility is enforced here at the app layer too, so callers running under
 * system context (memory attach) never see another org's scripts.
 */
import { and, desc, eq, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { devices, organizations, playbookDefinitions, scripts, scriptTemplates } from '../../db/schema';
import { SYSTEM_LIBRARY_SCRIPTS } from '../systemScriptLibrary';
import { isFixOsFamily, type FixOsFamily } from './signature';

export interface CatalogContext { orgId: string; partnerId: string | null; deviceOs: FixOsFamily | null }

// Script languages a device OS can run. Templates carry a language but no OS
// list; python runs everywhere, and a null language is left unfiltered.
export const TEMPLATE_LANGUAGES_BY_OS: Readonly<Record<FixOsFamily, ReadonlySet<string>>> = {
  windows: new Set(['powershell', 'cmd', 'python']),
  linux: new Set(['bash', 'python']),
  macos: new Set(['bash', 'python']),
};

// The system script library holds agent-lifecycle tooling, not remediations
// (#7118) — never offered as a fix.
export const NON_REMEDIATION_SYSTEM_SCRIPT_NAMES: readonly string[] = SYSTEM_LIBRARY_SCRIPTS.map((def) => def.name);

export function scriptVisibilityCondition(ctx: CatalogContext): SQL {
  const owners: SQL[] = [eq(scripts.isSystem, true), eq(scripts.orgId, ctx.orgId)];
  if (ctx.partnerId) owners.push(and(isNull(scripts.orgId), eq(scripts.partnerId, ctx.partnerId))!);
  const conditions: SQL[] = [isNull(scripts.deletedAt), or(...owners)!];
  if (NON_REMEDIATION_SYSTEM_SCRIPT_NAMES.length > 0) {
    conditions.push(or(eq(scripts.isSystem, false), notInArray(scripts.name, [...NON_REMEDIATION_SYSTEM_SCRIPT_NAMES]))!);
  }
  if (ctx.deviceOs) conditions.push(sql`${scripts.osTypes} @> ARRAY[${ctx.deviceOs}]::text[]`);
  return and(...conditions)!;
}

export async function listCatalogScripts(ctx: CatalogContext, limit = 100) {
  return db.select({
    id: scripts.id, name: scripts.name, description: scripts.description, category: scripts.category,
    runAs: scripts.runAs, osTypes: scripts.osTypes, isSystem: scripts.isSystem,
  }).from(scripts).where(scriptVisibilityCondition(ctx)).orderBy(desc(scripts.updatedAt)).limit(limit);
}

export async function listCatalogTemplates(_ctx: CatalogContext, limit = 100) {
  return db.select({
    id: scriptTemplates.id, name: scriptTemplates.name, description: scriptTemplates.description,
    category: scriptTemplates.category, rating: scriptTemplates.rating, language: scriptTemplates.language,
  }).from(scriptTemplates).orderBy(desc(scriptTemplates.downloads)).limit(limit);
}

export async function listCatalogPlaybooks(ctx: CatalogContext, limit = 100) {
  return db.select({
    id: playbookDefinitions.id, name: playbookDefinitions.name, description: playbookDefinitions.description,
    category: playbookDefinitions.category, isBuiltIn: playbookDefinitions.isBuiltIn,
  }).from(playbookDefinitions)
    .where(and(eq(playbookDefinitions.isActive, true), or(eq(playbookDefinitions.isBuiltIn, true), eq(playbookDefinitions.orgId, ctx.orgId))!))
    .orderBy(playbookDefinitions.category, playbookDefinitions.name)
    .limit(limit);
}

export async function resolveDeviceOs(deviceId: string | null): Promise<FixOsFamily | null> {
  if (!deviceId) return null;
  const [row] = await db.select({ osType: devices.osType }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  return isFixOsFamily(row?.osType) ? (row!.osType as FixOsFamily) : null;
}

export async function resolveOrgPartnerId(orgId: string): Promise<string | null> {
  const [row] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return row?.partnerId ?? null;
}
