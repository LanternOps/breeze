/**
 * `manage_snmp_templates` (full-control W09, #6779): the AI twin of the template
 * and OID routes in routes/snmp.ts.
 *
 * The routes' rules live in services/snmpTemplates.ts (org resolution, template
 * visibility, built-in / org mutation, OID browse + validate) and are called
 * here unchanged.
 *
 * Reads are tier 1. create / update / delete are tier 2 (a template is a
 * tenant-internal row; an edit can be edited back and the delete result carries
 * the removed row). Beyond the route:
 *  - the write must satisfy the MFA the route's `requireMfa()` asks for (QW4);
 *  - a site- or device-restricted caller is refused (W09-D3): the row is read by
 *    every device on it, in every site;
 *  - a template with no org (a system-scope row) is never written (QW3).
 */
import { and, desc, eq, like, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../db';
import { snmpDevices, snmpTemplates } from '../db/schema';
import type { AiTool } from './aiTools';
import {
  browseOidRows, canMutateTemplate, createTemplateSchema, escapeLikePattern, listTemplatesSchema, resolveOrgId,
  templateVisibilityCondition, templateView, updateTemplateSchema, validateOidRows, validateOidsSchema,
} from './snmpTemplates';
import { SNMP_TEMPLATE_ACTIONS } from './aiToolSchemasNetworkMonitoring';
import { parseData } from './aiToolsTicketOpsShared';
import { bounded, defined, json, jsonError, mfaDenied, requireFields, restrictedCallerDenied, thrown } from './aiToolsNetworkMonitoringShared';

type Action = (typeof SNMP_TEMPLATE_ACTIONS)[number];

const LIST_CAP = 200;
const NOT_FOUND = 'Template not found';
const WRITE_ACTIONS: readonly Action[] = ['create', 'update', 'delete'];

export function registerSnmpTemplateTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_snmp_templates', {
    tier: 1,
    domain: 'network',
    searchHint: 'SNMP monitoring templates, OIDs to poll per device class, built-in vs custom, validate an OID list',
    deviceArgs: [],
    definition: {
      name: 'manage_snmp_templates',
      description:
        'SNMP monitoring templates (the OIDs polled per device class). Actions: list,get (templateId),browse_oids (query),validate_oids (oids),create (name,oids),update (templateId),delete (templateId). Built-ins are read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...SNMP_TEMPLATE_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (partner callers with several orgs; required for create)' },
          templateId: { type: 'string', description: 'get/update/delete: template UUID' },
          source: { type: 'string', enum: ['builtin', 'custom'], description: 'list: filter by source' },
          search: { type: 'string', description: 'list: match name, vendor or device type' },
          name: { type: 'string', description: 'create/update: template name' },
          description: { type: 'string', description: 'create/update: description' },
          vendor: { type: 'string', description: 'create/update: vendor' },
          deviceType: { type: 'string', description: 'create/update: device class (switch, printer, ups…)' },
          oids: {
            type: 'array',
            description: 'create/update/validate_oids: OID rows {oid,name,type,unit,mode:get|walk,cadence:fast|slow,description}',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, oid: { type: 'string' }, name: { type: 'string' }, label: { type: 'string' },
                unit: { type: 'string' }, type: { type: 'string' }, mode: { type: 'string', enum: ['get', 'walk'] },
                cadence: { type: 'string', enum: ['fast', 'slow'] }, description: { type: 'string' },
              },
              required: ['oid'],
              additionalProperties: false,
            },
          },
          query: { type: 'string', description: 'browse_oids: text to match against OID, name or description' },
          limit: { type: 'number', description: 'browse_oids: max results (1-100, default 25)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!SNMP_TEMPLATE_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);

      if (WRITE_ACTIONS.includes(action)) {
        const mfa = mfaDenied(auth);
        if (mfa) return mfa;
        const restricted = restrictedCallerDenied(auth, 'An SNMP template');
        if (restricted) return restricted;
      }

      try {
        switch (action) {
          case 'list': {
            const parsed = parseData(listTemplatesSchema, defined({ orgId: input.orgId, source: input.source, search: input.search }));
            if ('error' in parsed) return parsed.error;
            const query = parsed.value;
            const visibility = templateVisibilityCondition(auth, query.orgId);
            if (visibility.error) return jsonError(visibility.error, 'ACCESS_DENIED');
            const conditions: SQL[] = [];
            if (visibility.condition) conditions.push(visibility.condition);
            if (query.source === 'builtin') conditions.push(eq(snmpTemplates.isBuiltIn, true));
            else if (query.source === 'custom') conditions.push(eq(snmpTemplates.isBuiltIn, false));
            if (query.search) {
              const escaped = escapeLikePattern(query.search);
              conditions.push(or(
                like(snmpTemplates.name, `%${escaped}%`),
                like(snmpTemplates.vendor, `%${escaped}%`),
                like(snmpTemplates.deviceType, `%${escaped}%`),
              )!);
            }
            const rows = await db.select().from(snmpTemplates)
              .where(conditions.length ? and(...conditions) : undefined)
              .orderBy(desc(snmpTemplates.createdAt))
              .limit(LIST_CAP + 1);
            const page = rows.slice(0, LIST_CAP);
            return bounded({
              templates: page.map((t) => {
                const { oids, ...rest } = templateView(t);
                return { ...rest, oidCount: Array.isArray(oids) ? oids.length : 0 };
              }),
              truncated: rows.length > LIST_CAP,
            });
          }
          case 'get': {
            const missing = requireFields(input, ['templateId'], action);
            if (missing) return missing;
            const visibility = templateVisibilityCondition(auth);
            if (visibility.error) return jsonError(visibility.error, 'ACCESS_DENIED');
            const conditions: SQL[] = [eq(snmpTemplates.id, String(input.templateId))];
            if (visibility.condition) conditions.push(visibility.condition);
            const [template] = await db.select().from(snmpTemplates).where(and(...conditions)).limit(1);
            if (!template) return jsonError(NOT_FOUND, 'NOT_FOUND');
            return bounded({ template: templateView(template) });
          }
          case 'browse_oids': {
            const visibility = templateVisibilityCondition(auth);
            if (visibility.error) return jsonError(visibility.error, 'ACCESS_DENIED');
            const templates = await db.select({ name: snmpTemplates.name, oids: snmpTemplates.oids })
              .from(snmpTemplates).where(visibility.condition);
            const limit = typeof input.limit === 'number' ? Math.min(100, Math.max(1, Math.floor(input.limit))) : 25;
            return bounded(browseOidRows(templates, typeof input.query === 'string' ? input.query : '', limit));
          }
          case 'validate_oids': {
            const parsed = parseData(validateOidsSchema, { oids: input.oids });
            if ('error' in parsed) return parsed.error;
            const visibility = templateVisibilityCondition(auth);
            if (visibility.error) return jsonError(visibility.error, 'ACCESS_DENIED');
            const templates = await db.select({ oids: snmpTemplates.oids })
              .from(snmpTemplates).where(visibility.condition);
            return bounded(validateOidRows(templates, parsed.value.oids));
          }
          case 'create': {
            const missing = requireFields(input, ['name', 'oids'], action);
            if (missing) return missing;
            const parsed = parseData(createTemplateSchema, defined({
              orgId: input.orgId, name: input.name, description: input.description,
              vendor: input.vendor, deviceType: input.deviceType, oids: input.oids,
            }));
            if ('error' in parsed) return parsed.error;
            const payload = parsed.value;
            const orgResult = resolveOrgId(auth, payload.orgId, true);
            if ('error' in orgResult) return jsonError(orgResult.error, 'ACCESS_DENIED');
            const [template] = await db.insert(snmpTemplates).values({
              orgId: orgResult.orgId!,
              name: payload.name,
              description: payload.description ?? null,
              vendor: payload.vendor ?? null,
              deviceType: payload.deviceType ?? null,
              oids: payload.oids,
              isBuiltIn: false,
            }).returning();
            if (!template) return jsonError('Failed to create SNMP template.');
            return json({ created: true, template: templateView(template) });
          }
          case 'update':
          case 'delete': {
            const missing = requireFields(input, ['templateId'], action);
            if (missing) return missing;
            const visibility = templateVisibilityCondition(auth);
            if (visibility.error) return jsonError(visibility.error, 'ACCESS_DENIED');
            const conditions: SQL[] = [eq(snmpTemplates.id, String(input.templateId))];
            if (visibility.condition) conditions.push(visibility.condition);
            const [template] = await db.select().from(snmpTemplates).where(and(...conditions)).limit(1);
            // Hidden and absent are one answer: the route's 403 would let a caller fingerprint another org's template ids.
            if (!template) return jsonError(NOT_FOUND, 'NOT_FOUND');
            if (template.isBuiltIn) return jsonError(`Built-in templates cannot be ${action === 'update' ? 'modified' : 'deleted'}.`, 'BUILT_IN');
            // QW3: a system-scope row (no org) is broader than any tenant caller's authority.
            if (!template.orgId || !canMutateTemplate(auth, template)) return jsonError(NOT_FOUND, 'NOT_FOUND');

            if (action === 'update') {
              const parsed = parseData(updateTemplateSchema, defined({
                name: input.name, description: input.description, vendor: input.vendor,
                deviceType: input.deviceType, oids: input.oids,
              }));
              if ('error' in parsed) return parsed.error;
              const payload = parsed.value;
              const updates: Record<string, unknown> = {};
              if (payload.name !== undefined) updates.name = payload.name;
              if (payload.description !== undefined) updates.description = payload.description;
              if (payload.vendor !== undefined) updates.vendor = payload.vendor;
              if (payload.deviceType !== undefined) updates.deviceType = payload.deviceType;
              if (payload.oids !== undefined) updates.oids = payload.oids;
              if (Object.keys(updates).length === 0) return jsonError('Nothing to update: supply name, description, vendor, deviceType or oids', 'VALIDATION_ERROR');
              const [updated] = await db.update(snmpTemplates).set(updates)
                .where(eq(snmpTemplates.id, template.id)).returning();
              if (!updated) return jsonError('Failed to update SNMP template.');
              return json({ updated: true, template: templateView(updated), updatedFields: Object.keys(updates) });
            }

            // Checked up front: a foreign-key violation inside the per-call transaction would poison it.
            const [inUse] = await db.select({ id: snmpDevices.id }).from(snmpDevices)
              .where(eq(snmpDevices.templateId, template.id)).limit(1);
            if (inUse) {
              return jsonError('This template is still used by SNMP devices; move them to another template first', 'IN_USE');
            }
            const [removed] = await db.delete(snmpTemplates).where(eq(snmpTemplates.id, template.id)).returning();
            if (!removed) return jsonError('Failed to delete SNMP template.');
            // The removed row is returned whole: it is the restore point (recreate it with `create`).
            return json({ deleted: true, template: templateView(removed) });
          }
        }
      } catch (error) {
        return thrown('manage_snmp_templates', error);
      }
    },
  });
}
