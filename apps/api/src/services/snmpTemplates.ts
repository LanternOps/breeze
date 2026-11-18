/**
 * SNMP template rules shared by routes/snmp.ts and the AI tool
 * `manage_snmp_templates` (full-control W09, #6779).
 *
 * Moved verbatim out of routes/snmp.ts so the REST routes and the tool share
 * ONE copy of the org resolution, template visibility, built-in/org mutation
 * rule and OID validation. Bodies are unchanged; nothing here touches a route
 * or a request context.
 */
import { z } from 'zod';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { snmpTemplates } from '../db/schema';

export function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}
export function resolveOrgId(
  auth: { scope: string; orgId: string | null; canAccessOrg: (orgId: string) => boolean; accessibleOrgIds: string[] | null },
  requestedOrgId?: string,
  requireForNonOrg = false
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required', status: 403 } as const;
    if (requestedOrgId && requestedOrgId !== auth.orgId) return { error: 'Access denied', status: 403 } as const;
    return { orgId: auth.orgId } as const;
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access denied', status: 403 } as const;
    }
    return { orgId: requestedOrgId } as const;
  }

  if (auth.scope === 'partner') {
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (!requireForNonOrg && accessibleOrgIds.length === 1) {
      return { orgId: accessibleOrgIds[0] } as const;
    }
    return { error: 'orgId is required when partner has multiple organizations', status: 400 } as const;
  }

  if (auth.scope === 'system' && !requestedOrgId) {
    return { error: 'orgId is required for system scope', status: 400 } as const;
  }

  if (requireForNonOrg && !requestedOrgId) return { error: 'orgId is required', status: 400 } as const;
  return { orgId: requestedOrgId ?? auth.orgId ?? null } as const;
}
// --- Zod Schemas ---

export const listTemplatesSchema = z.object({
  orgId: z.string().guid().optional(),
  source: z.enum(['builtin', 'custom']).optional(),
  search: z.string().optional()
});

export const dashboardQuerySchema = z.object({
  orgId: z.string().guid().optional(),
});

export const oidSchema = z.object({
  oid: z.string().min(1),
  name: z.string().min(1),
  label: z.string().optional(),
  unit: z.string().optional(),
  type: z.string().optional(),
  // Acquisition hints consumed by services/snmpOidSpecs.ts (W02). Optional:
  // omitted entries fall back to the `.0` => get / else walk default and
  // `fast`. Without these fields the non-strict z.object SILENTLY STRIPPED
  // them from custom templates.
  mode: z.enum(['get', 'walk']).optional(),
  cadence: z.enum(['fast', 'slow']).optional(),
  description: z.string().optional()
});

export const createTemplateSchema = z.object({
  orgId: z.string().guid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  vendor: z.string().optional(),
  deviceType: z.string().optional(),
  oids: z.array(oidSchema)
});

export const updateTemplateSchema = createTemplateSchema.partial();

export const browseOidsSchema = z.object({
  query: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

export const validateOidsSchema = z.object({
  oids: z.array(
    z.object({
      id: z.string().optional(),
      oid: z.string().min(1),
      name: z.string().optional(),
      type: z.string().optional(),
      description: z.string().optional()
    })
  ).min(1)
});

export type OidCatalogEntry = {
  oid: string;
  name: string;
  type: string;
  description: string;
};

export const oidCatalog: OidCatalogEntry[] = [
  {
    oid: '1.3.6.1.2.1.1.1.0',
    name: 'sysDescr',
    type: 'OctetString',
    description: 'System description'
  },
  {
    oid: '1.3.6.1.2.1.1.3.0',
    name: 'sysUpTime',
    type: 'TimeTicks',
    description: 'Time since network management system was last initialized'
  },
  {
    oid: '1.3.6.1.2.1.1.5.0',
    name: 'sysName',
    type: 'OctetString',
    description: 'Device hostname'
  },
  {
    oid: '1.3.6.1.2.1.2.2.1.10',
    name: 'ifInOctets',
    type: 'Counter64',
    description: 'Inbound octets per interface'
  },
  {
    oid: '1.3.6.1.2.1.2.2.1.16',
    name: 'ifOutOctets',
    type: 'Counter64',
    description: 'Outbound octets per interface'
  },
  {
    oid: '1.3.6.1.2.1.25.3.3.1.2',
    name: 'hrProcessorLoad',
    type: 'Gauge',
    description: 'Host processor load'
  },
  {
    oid: '1.3.6.1.4.1.2021.4.6.0',
    name: 'memAvailableReal',
    type: 'Gauge',
    description: 'Available physical memory'
  },
  {
    oid: '1.3.6.1.4.1.2021.9.1.9',
    name: 'dskPercent',
    type: 'Gauge',
    description: 'Disk utilization percentage'
  }
];

export function normalizeOidString(value: string): string {
  return value.trim().replace(/^\.+/, '');
}

export function isNumericOid(value: string): boolean {
  return /^\d+(?:\.\d+)+$/.test(value);
}

export function templateVisibilityCondition(
  auth: { scope: string; orgId: string | null; canAccessOrg: (orgId: string) => boolean; accessibleOrgIds: string[] | null },
  requestedOrgId?: string
): { condition?: SQL; error?: string; status?: 400 | 403 } {
  if (auth.scope === 'system' && !requestedOrgId) {
    return {};
  }

  if (requestedOrgId) {
    const orgResult = resolveOrgId(auth, requestedOrgId);
    if ('error' in orgResult) return { error: orgResult.error, status: orgResult.status };
    return {
      condition: or(eq(snmpTemplates.isBuiltIn, true), eq(snmpTemplates.orgId, orgResult.orgId!))!,
    };
  }

  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required', status: 403 };
    return {
      condition: or(eq(snmpTemplates.isBuiltIn, true), eq(snmpTemplates.orgId, auth.orgId))!,
    };
  }

  const orgIds = auth.accessibleOrgIds ?? [];
  if (orgIds.length === 0) {
    return { condition: eq(snmpTemplates.isBuiltIn, true) };
  }
  return {
    condition: or(eq(snmpTemplates.isBuiltIn, true), inArray(snmpTemplates.orgId, orgIds))!,
  };
}

export function canMutateTemplate(
  auth: { scope: string; canAccessOrg: (orgId: string) => boolean },
  template: Pick<typeof snmpTemplates.$inferSelect, 'isBuiltIn' | 'orgId'>
): boolean {
  if (template.isBuiltIn) return false;
  if (template.orgId) return auth.canAccessOrg(template.orgId);
  return auth.scope === 'system';
}

// --- OID browse / validate (shared by the route and the tool) ---

export type OidBrowseResult = {
  oid: string;
  name: string;
  type: string;
  description: string;
  source: 'catalog' | 'template';
  templateName?: string;
};

type TemplateOidRow = { name?: string | null; oids: unknown };

/** The built-in catalog merged with every OID in the visible templates, filtered by `query`. */
export function browseOidRows(
  templates: TemplateOidRow[],
  query: string,
  limit: number,
): { total: number; results: OidBrowseResult[] } {
  const normalizedQuery = query.trim().toLowerCase();
  const candidates = new Map<string, OidBrowseResult>();

  for (const entry of oidCatalog) {
    const normalizedOid = normalizeOidString(entry.oid);
    candidates.set(normalizedOid, { ...entry, oid: normalizedOid, source: 'catalog' });
  }

  for (const template of templates) {
    if (!Array.isArray(template.oids)) continue;

    for (const rawOid of template.oids as Array<Record<string, unknown>>) {
      const oid = normalizeOidString(String(rawOid.oid ?? ''));
      if (!oid) continue;

      const existing = candidates.get(oid);
      candidates.set(oid, {
        oid,
        name: String(rawOid.name ?? rawOid.label ?? existing?.name ?? 'Unnamed OID'),
        type: String(rawOid.type ?? existing?.type ?? 'Gauge'),
        description: String(rawOid.description ?? existing?.description ?? ''),
        source: existing?.source ?? 'template',
        templateName: existing?.templateName ?? template.name ?? undefined,
      });
    }
  }

  const filtered = Array.from(candidates.values()).filter((entry) => {
    if (!normalizedQuery) return true;
    const haystack = `${entry.oid} ${entry.name} ${entry.description}`.toLowerCase();
    return haystack.includes(normalizedQuery);
  });

  return { total: filtered.length, results: filtered.slice(0, limit) };
}

export type OidValidationInput = { id?: string; oid: string; name?: string; type?: string; description?: string };

/** Per-OID format, duplicate and "known to the catalog or a visible template" checks. */
export function validateOidRows(templates: Array<{ oids: unknown }>, oids: OidValidationInput[]) {
  const knownOids = new Set(oidCatalog.map((entry) => normalizeOidString(entry.oid)));
  for (const template of templates) {
    if (!Array.isArray(template.oids)) continue;
    for (const rawOid of template.oids as Array<Record<string, unknown>>) {
      knownOids.add(normalizeOidString(String(rawOid.oid ?? '')));
    }
  }

  const seen = new Set<string>();
  const results = oids.map((item, index) => {
    const normalizedOid = normalizeOidString(item.oid);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!isNumericOid(normalizedOid)) {
      errors.push('OID must use dotted numeric format (e.g. 1.3.6.1.2.1.1.3.0).');
    }

    if (seen.has(normalizedOid)) {
      errors.push('Duplicate OID in template payload.');
    } else {
      seen.add(normalizedOid);
    }

    if (isNumericOid(normalizedOid) && !knownOids.has(normalizedOid)) {
      warnings.push('OID not found in catalog/templates. Verify this path exists on the target device.');
    }

    return { index, id: item.id, oid: item.oid, normalizedOid, valid: errors.length === 0, errors, warnings };
  });

  return { valid: results.every((result) => result.valid), results };
}

/** The route's template wire shape (get/create/update all return this projection). */
export function templateView(t: typeof snmpTemplates.$inferSelect) {
  return {
    id: t.id,
    orgId: t.orgId,
    name: t.name,
    description: t.description,
    source: t.isBuiltIn ? 'builtin' : 'custom',
    vendor: t.vendor,
    deviceClass: t.deviceType,
    oids: t.oids,
    createdAt: t.createdAt.toISOString(),
  };
}
