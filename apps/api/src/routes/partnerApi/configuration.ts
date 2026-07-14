import type { Context } from 'hono';
import { Hono } from 'hono';
import { sql, type SQL } from 'drizzle-orm';
import {
  CONFIG_POLICY_PATCH_INLINE_MIRROR_KEY,
  containsConfigPolicyReservedKey,
  patchInlineSettingsSchema,
} from '@breeze/shared/validators';
import { db } from '../../db';
import { requirePartnerApiScope, type PartnerApiPrincipalContext } from '../../middleware/partnerApiAuth';
import { acquirePartnerExportReadLocks } from './consistency';
import { getPartnerExportFetchLimit } from './pagination';
import {
  normalizePatchInlineSettings,
  tryNormalizePatchInlineSettings,
} from '../../services/configPolicyPatching';
import {
  bindPartnerExportSnapshot,
  buildEnvelope,
  clientError,
  isKnownClientError,
  normalizeSourceRow,
  parseExportQuery,
  type ExportQueryInput,
} from './organizations';
import {
  automationExportEnvelopeSchema,
  backupConfigurationExportEnvelopeSchema,
  configurationAssignmentExportEnvelopeSchema,
  configurationPolicyExportEnvelopeSchema,
  customFieldExportEnvelopeSchema,
  customFieldValueExportEnvelopeSchema,
  scriptExportEnvelopeSchema,
  type PartnerExportResource,
} from './schemas';

interface DesiredConfigurationRow extends Record<string, unknown> {
  id: string;
  orgId: string;
  siteId: null;
  createdAt: Date | string;
  updatedAt: Date | string;
  definition: Record<string, unknown>;
}

const PATCH_NORMALIZED_MATERIAL_KEYS = [
  'sources',
  'autoApprove',
  'autoApproveSeverities',
  'scheduleFrequency',
  'scheduleTime',
  'scheduleDayOfWeek',
  'scheduleDayOfMonth',
  'rebootPolicy',
  'exclusiveWindowsUpdate',
] as const;
const PATCH_NORMALIZED_MATERIAL_KEY_SET = new Set<string>(PATCH_NORMALIZED_MATERIAL_KEYS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Convert the database's internal patch material into the same canonical
 * settings used by Breeze's policy read path. The raw mirror is deliberately
 * removed here, before secret inspection, revision hashing, or DTO parsing.
 */
function canonicalizePolicyPatchSettings(
  definition: Record<string, unknown>,
): { safe: true; definition: Record<string, unknown> } | { safe: false } {
  const definitionMetadata = { ...definition };
  delete definitionMetadata.features;
  if (containsConfigPolicyReservedKey(definitionMetadata)) return { safe: false };
  // The export DTO requires an array. Treat malformed/missing feature
  // material as blocked here too, before it can enter revision hashing.
  if (!Array.isArray(definition.features)) return { safe: false };

  const features: unknown[] = [];
  for (const feature of definition.features) {
    if (!isRecord(feature)) {
      if (containsConfigPolicyReservedKey(feature)) return { safe: false };
      features.push(feature);
      continue;
    }

    const featureMetadata = { ...feature };
    delete featureMetadata.settings;
    if (containsConfigPolicyReservedKey(featureMetadata)) return { safe: false };

    if (feature.type !== 'patch') {
      if (containsConfigPolicyReservedKey(feature.settings)) return { safe: false };
      features.push(feature);
      continue;
    }

    if (
      !isRecord(feature.settings)
      || !Object.prototype.hasOwnProperty.call(
        feature.settings,
        CONFIG_POLICY_PATCH_INLINE_MIRROR_KEY,
      )
    ) {
      return { safe: false };
    }

    const featureSettings = feature.settings;
    const materialKeys = Object.keys(featureSettings);
    if (
      materialKeys.length !== PATCH_NORMALIZED_MATERIAL_KEYS.length + 1
      || PATCH_NORMALIZED_MATERIAL_KEYS.some((key) => featureSettings[key] === undefined)
      || materialKeys.some((key) => (
        key !== CONFIG_POLICY_PATCH_INLINE_MIRROR_KEY
        && !PATCH_NORMALIZED_MATERIAL_KEY_SET.has(key)
      ))
    ) {
      return { safe: false };
    }

    const materialized = { ...featureSettings };
    const rawMirror = materialized[CONFIG_POLICY_PATCH_INLINE_MIRROR_KEY];
    delete materialized[CONFIG_POLICY_PATCH_INLINE_MIRROR_KEY];
    if (containsConfigPolicyReservedKey(materialized) || containsConfigPolicyReservedKey(rawMirror)) {
      return { safe: false };
    }
    const normalizedMaterial = patchInlineSettingsSchema.safeParse(materialized);
    if (!normalizedMaterial.success) return { safe: false };

    const canonicalMirror = tryNormalizePatchInlineSettings(rawMirror).settings;
    const settings = normalizePatchInlineSettings({
      ...normalizedMaterial.data,
      autoApproveDeferralDays: canonicalMirror.autoApproveDeferralDays,
      apps: canonicalMirror.apps,
    });
    features.push({ ...feature, settings });
  }

  return { safe: true, definition: { ...definition, features } };
}

const CONFIGURATION_FAILURE = {
  'configuration-policies': 'Partner configuration policy export failed.',
  'configuration-assignments': 'Partner configuration assignment export failed.',
  scripts: 'Partner script export failed.',
  automations: 'Partner automation export failed.',
  'backup-configurations': 'Partner backup configuration export failed.',
  'custom-fields': 'Partner custom field export failed.',
  'custom-field-values': 'Partner custom field value export failed.',
} as const;

function uuidArray(values: readonly string[]): SQL {
  return values.length === 0
    ? sql`ARRAY[]::uuid[]`
    : sql`ARRAY[${sql.join(values.map((value) => sql`${value}::uuid`), sql`, `)}]`;
}

function effectiveOrganizations(
  principal: PartnerApiPrincipalContext,
  query: ExportQueryInput,
  resource: keyof typeof CONFIGURATION_FAILURE,
): SQL {
  const ids = query.orgId ? [query.orgId] : principal.accessibleOrgIds;
  const stateResource = resource === 'custom-field-values' ? 'custom-fields' : resource;
  return sql`
    SELECT o.id, o.partner_export_updated_at, state.updated_at AS material_updated_at
    FROM public.organizations o
    JOIN public.partner_export_configuration_org_state state
      ON state.org_id = o.id AND state.resource = ${stateResource}
    WHERE o.partner_id = ${principal.partnerId}::uuid
      AND o.id = ANY(${uuidArray(ids)})
  `;
}

function pageQuery(source: SQL, query: ExportQueryInput): SQL {
  const snapshotAt = query.traversal.snapshotAt;
  const updatedWindow = query.traversal.mode === 'incremental'
    ? sql`source.updated_at > ${query.traversal.updatedSince!}::timestamp AND source.updated_at <= ${snapshotAt}::timestamp`
    : sql`source.created_at <= ${snapshotAt}::timestamp`;
  let after = sql``;
  if (query.traversal.after) {
    const cursor = query.traversal.after;
    after = query.traversal.mode === 'incremental'
      ? sql`AND (
          source.updated_at > ${cursor.lastUpdatedAt!}::timestamp
          OR (source.updated_at = ${cursor.lastUpdatedAt!}::timestamp AND source.id > ${cursor.lastId}::uuid)
          OR (source.updated_at = ${cursor.lastUpdatedAt!}::timestamp AND source.id = ${cursor.lastId}::uuid AND source.org_id > ${cursor.lastOrgId}::uuid)
        )`
      : sql`AND (
          source.id > ${cursor.lastId}::uuid
          OR (source.id = ${cursor.lastId}::uuid AND source.org_id > ${cursor.lastOrgId}::uuid)
        )`;
  }
  const order = query.traversal.mode === 'incremental'
    ? sql`source.updated_at, source.id, source.org_id`
    : sql`source.id, source.org_id`;
  return sql`
    WITH source AS (${source})
    SELECT
      source.id AS "id",
      source.org_id AS "orgId",
      NULL::uuid AS "siteId",
      to_char(source.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
      to_char(source.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
      source.definition AS "definition"
    FROM source
    WHERE ${updatedWindow}
    ${after}
    ORDER BY ${order}
    LIMIT ${getPartnerExportFetchLimit(query.limit)}
  `;
}

function assignmentEffectiveOrgSql(partnerId: string): SQL {
  return sql`
    JOIN LATERAL (
      SELECT eo.id AS org_id, eo.partner_export_updated_at, eo.material_updated_at
      FROM effective_orgs eo
      WHERE
        (a.level = 'partner' AND a.target_id = ${partnerId}::uuid)
        OR (a.level = 'organization' AND a.target_id = eo.id)
        OR (a.level = 'site' AND EXISTS (
          SELECT 1 FROM public.sites st WHERE st.id = a.target_id AND st.org_id = eo.id
        ))
        OR (a.level = 'device_group' AND EXISTS (
          SELECT 1 FROM public.device_groups dg WHERE dg.id = a.target_id AND dg.org_id = eo.id
        ))
        OR (a.level = 'device' AND EXISTS (
          SELECT 1 FROM public.devices dv WHERE dv.id = a.target_id AND dv.org_id = eo.id
        ))
    ) resolved ON true
  `;
}

function policySource(principal: PartnerApiPrincipalContext, query: ExportQueryInput): SQL {
  // The inline feature document is intentionally indivisible. The recursive
  // guard blocks the entire policy if any nested setting is secret-like.
  return sql`
    WITH effective_orgs AS (${effectiveOrganizations(principal, query, 'configuration-policies')}),
    assignment_orgs AS (
      SELECT a.id AS assignment_id, cp.id AS policy_id, resolved.org_id,
             resolved.partner_export_updated_at, resolved.material_updated_at,
             a.created_at AS assignment_updated_at
      FROM public.configuration_policies cp
      JOIN public.config_policy_assignments a ON a.config_policy_id = cp.id
      ${assignmentEffectiveOrgSql(principal.partnerId)}
      WHERE (cp.org_id = resolved.org_id OR (cp.org_id IS NULL AND cp.partner_id = ${principal.partnerId}::uuid))
    )
    SELECT cp.id, ao.org_id,
      cp.created_at,
      ao.material_updated_at AS updated_at,
      jsonb_build_object(
        'sourceScope', CASE WHEN cp.org_id IS NULL THEN 'partner' ELSE 'organization' END,
        'name', cp.name,
        'description', cp.description,
        'status', cp.status,
        'features', COALESCE(features.items, '[]'::jsonb)
      ) AS definition
    FROM public.configuration_policies cp
    JOIN (
      SELECT policy_id, org_id, MAX(partner_export_updated_at) AS partner_export_updated_at,
             MAX(material_updated_at) AS material_updated_at
      FROM assignment_orgs GROUP BY policy_id, org_id
    ) ao ON ao.policy_id = cp.id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
          'id', fl.id,
          'type', fl.feature_type,
          'policyId', fl.feature_policy_id,
          'settings', public.breeze_partner_export_effective_policy_settings(
            fl.id, fl.feature_type::text, fl.inline_settings
          )
        ) ORDER BY fl.feature_type, fl.id) AS items,
        MAX(fl.updated_at) AS updated_at
      FROM public.config_policy_feature_links fl
      WHERE fl.config_policy_id = cp.id
    ) features ON true
    LEFT JOIN LATERAL (
      SELECT MAX(a.created_at) AS updated_at
      FROM public.config_policy_assignments a
      WHERE a.config_policy_id = cp.id
    ) assignments ON true
  `;
}

function assignmentSource(principal: PartnerApiPrincipalContext, query: ExportQueryInput): SQL {
  return sql`
    WITH effective_orgs AS (${effectiveOrganizations(principal, query, 'configuration-assignments')})
    SELECT a.id, resolved.org_id, a.created_at,
      resolved.material_updated_at AS updated_at,
      jsonb_build_object(
        'policyId', cp.id,
        'policyName', cp.name,
        'sourceScope', CASE WHEN cp.org_id IS NULL THEN 'partner' ELSE 'organization' END,
        'level', a.level,
        'targetId', a.target_id,
        'priority', a.priority,
        'roleFilter', a.role_filter,
        'osFilter', a.os_filter
      ) AS definition
    FROM public.configuration_policies cp
    JOIN public.config_policy_assignments a ON a.config_policy_id = cp.id
    ${assignmentEffectiveOrgSql(principal.partnerId)}
    WHERE cp.org_id = resolved.org_id
       OR (cp.org_id IS NULL AND cp.partner_id = ${principal.partnerId}::uuid)
  `;
}

function scriptSource(principal: PartnerApiPrincipalContext, query: ExportQueryInput): SQL {
  return sql`
    WITH effective_orgs AS (${effectiveOrganizations(principal, query, 'scripts')})
    SELECT s.id, eo.id AS org_id, s.created_at,
      eo.material_updated_at AS updated_at,
      jsonb_build_object(
        'sourceScope', CASE WHEN s.org_id IS NULL THEN 'partner' ELSE 'organization' END,
        'name', s.name, 'description', s.description, 'category', s.category,
        'osTypes', s.os_types, 'language', s.language, 'content', s.content,
        'parameters', s.parameters, 'timeoutSeconds', s.timeout_seconds,
        'runAs', s.run_as, 'version', s.version,
        'exitCodeSeverityMapping', s.exit_code_severity_mapping
      ) AS definition
    FROM public.scripts s
    JOIN effective_orgs eo ON s.org_id = eo.id
      OR (s.org_id IS NULL AND s.partner_id = ${principal.partnerId}::uuid)
    WHERE s.deleted_at IS NULL AND s.is_system = false
  `;
}

function automationSource(principal: PartnerApiPrincipalContext, query: ExportQueryInput): SQL {
  return sql`
    WITH effective_orgs AS (${effectiveOrganizations(principal, query, 'automations')})
    SELECT a.id, eo.id AS org_id, a.created_at,
      eo.material_updated_at AS updated_at,
      jsonb_build_object(
        'sourceScope', CASE WHEN a.org_id IS NULL THEN 'partner' ELSE 'organization' END,
        'name', a.name, 'description', a.description, 'enabled', a.enabled,
        'trigger', a.trigger, 'conditions', a.conditions, 'actions', a.actions,
        'onFailure', a.on_failure, 'notificationTargets', a.notification_targets,
        'dependencies', COALESCE(deps.items, '[]'::jsonb)
      ) AS definition
    FROM public.automations a
    JOIN effective_orgs eo ON a.org_id = eo.id
      OR (a.org_id IS NULL AND a.partner_id = ${principal.partnerId}::uuid)
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('resource', 'scripts', 'id', dependency_id)
                       ORDER BY dependency_id) AS items
      FROM (
        SELECT DISTINCT action->>'scriptId' AS dependency_id
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.actions) = 'array' THEN a.actions ELSE '[]'::jsonb END) action
        WHERE action->>'scriptId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ) dependencies
    ) deps ON true
  `;
}

function backupSource(principal: PartnerApiPrincipalContext, query: ExportQueryInput): SQL {
  return sql`
    WITH effective_orgs AS (${effectiveOrganizations(principal, query, 'backup-configurations')})
    SELECT bc.id, eo.id AS org_id, bc.created_at, eo.material_updated_at AS updated_at,
      jsonb_build_object(
        'kind', 'destination', 'sourceScope', 'organization', 'name', bc.name,
        'type', bc.type, 'provider', bc.provider, 'compression', bc.compression,
        'encryption', bc.encryption, 'active', bc.is_active, 'default', bc.is_default,
        'schedule', bc.schedule, 'retention', bc.retention, 'exclusions', '[]'::jsonb,
        'completenessGaps', jsonb_build_array(jsonb_build_object('code', 'restore_procedure_unavailable'))
      ) AS definition
    FROM public.backup_configs bc
    JOIN effective_orgs eo ON eo.id = bc.org_id

    UNION ALL

    SELECT bp.id, eo.id AS org_id, bp.created_at, eo.material_updated_at AS updated_at,
      jsonb_build_object(
        'kind', 'profile',
        'sourceScope', CASE WHEN bp.org_id IS NULL THEN 'partner' ELSE 'organization' END,
        'name', bp.name, 'description', bp.description, 'active', bp.is_active,
        'selections', bp.selections, 'destinationId', NULL,
        'schedule', NULL, 'retention', NULL,
        'exclusions', CASE
          WHEN jsonb_typeof(bp.selections #> '{file,excludes}') = 'array' THEN bp.selections #> '{file,excludes}'
          ELSE '[]'::jsonb END,
        'completenessGaps', jsonb_build_array(jsonb_build_object('code', 'restore_procedure_unavailable'))
      ) AS definition
    FROM public.backup_profiles bp
    JOIN effective_orgs eo ON bp.org_id = eo.id
      OR (bp.org_id IS NULL AND bp.partner_id = ${principal.partnerId}::uuid)

    UNION ALL

    SELECT pol.id, eo.id AS org_id, pol.created_at, eo.material_updated_at AS updated_at,
      jsonb_build_object(
        'kind', 'policy', 'sourceScope', 'organization', 'name', pol.name,
        'enabled', pol.enabled, 'destinationId', pol.config_id,
        'schedule', pol.schedule, 'retention', pol.retention, 'targets', pol.targets,
        'exclusions', CASE WHEN jsonb_typeof(pol.targets->'exclusions') = 'array'
          THEN pol.targets->'exclusions' ELSE '[]'::jsonb END,
        'completenessGaps', jsonb_build_array(jsonb_build_object('code', 'restore_procedure_unavailable')),
        'gfs', pol.gfs_config, 'legalHold', COALESCE(pol.legal_hold, false),
        'legalHoldReason', pol.legal_hold_reason,
        'bandwidthLimitMbps', pol.bandwidth_limit_mbps,
        'backupWindowStart', pol.backup_window_start,
        'backupWindowEnd', pol.backup_window_end,
        'priority', pol.priority
      ) AS definition
    FROM public.backup_policies pol
    JOIN public.backup_configs destination
      ON destination.id = pol.config_id AND destination.org_id = pol.org_id
    JOIN effective_orgs eo ON eo.id = pol.org_id
  `;
}

function customFieldSource(principal: PartnerApiPrincipalContext, query: ExportQueryInput): SQL {
  return sql`
    WITH effective_orgs AS (${effectiveOrganizations(principal, query, 'custom-fields')})
    SELECT f.id, eo.id AS org_id, f.created_at,
      eo.material_updated_at AS updated_at,
      jsonb_build_object(
        'sourceScope', CASE WHEN f.org_id IS NULL THEN 'partner' ELSE 'organization' END,
        'name', f.name, 'fieldKey', f.field_key, 'type', f.type,
        'options', f.options, 'required', f.required, 'defaultValue', f.default_value,
        'deviceTypes', f.device_types
      ) AS definition
    FROM public.custom_field_definitions f
    JOIN effective_orgs eo ON f.org_id = eo.id
      OR (f.org_id IS NULL AND f.partner_id = ${principal.partnerId}::uuid)
  `;
}

function customFieldValueSource(principal: PartnerApiPrincipalContext, query: ExportQueryInput): SQL {
  return sql`
    WITH effective_orgs AS (${effectiveOrganizations(principal, query, 'custom-field-values')}),
    value_rows AS (
      SELECT d.id AS device_id, d.site_id, d.created_at AS device_created_at,
        f.id AS definition_id, f.created_at AS definition_created_at,
        f.name, f.field_key, f.type, d.custom_fields->f.field_key AS value,
        eo.id AS org_id, eo.material_updated_at,
        md5(d.id::text || ':' || f.id::text) AS identity_hash
      FROM public.devices d
      JOIN effective_orgs eo ON eo.id = d.org_id
      JOIN public.custom_field_definitions f
        ON (f.org_id = eo.id OR (f.org_id IS NULL AND f.partner_id = ${principal.partnerId}::uuid))
       AND d.custom_fields ? f.field_key
    )
    SELECT (
        substr(identity_hash, 1, 8) || '-' || substr(identity_hash, 9, 4) || '-5' ||
        substr(identity_hash, 14, 3) || '-8' || substr(identity_hash, 18, 3) || '-' ||
        substr(identity_hash, 21, 12)
      )::uuid AS id,
      org_id, GREATEST(device_created_at, definition_created_at) AS created_at,
      material_updated_at AS updated_at,
      jsonb_build_object(
        'siteId', site_id,
        'deviceId', device_id,
        'definitionId', definition_id,
        'target', jsonb_build_object('type', 'device', 'id', device_id),
        'name', name, 'fieldKey', field_key, 'type', type, 'value', value
      ) AS definition
    FROM value_rows
  `;
}

function sourceQuery(resource: PartnerExportResource, principal: PartnerApiPrincipalContext, query: ExportQueryInput): SQL {
  switch (resource) {
    case 'configuration-policies': return policySource(principal, query);
    case 'configuration-assignments': return assignmentSource(principal, query);
    case 'scripts': return scriptSource(principal, query);
    case 'automations': return automationSource(principal, query);
    case 'backup-configurations': return backupSource(principal, query);
    case 'custom-fields': return customFieldSource(principal, query);
    case 'custom-field-values': return customFieldValueSource(principal, query);
    default: throw new TypeError(`Unsupported desired configuration resource: ${resource}`);
  }
}

async function exportResource(c: Context, resource: keyof typeof CONFIGURATION_FAILURE, schema: { parse(value: unknown): unknown }) {
  const principal = c.get('partnerApiPrincipal') as PartnerApiPrincipalContext;
  const parsed = parseExportQuery(c, resource, principal);
  if (parsed instanceof Response) return parsed;
  try {
    const orgIds = parsed.orgId ? [parsed.orgId] : principal.accessibleOrgIds;
    const snapshotAt = await acquirePartnerExportReadLocks(orgIds);
    bindPartnerExportSnapshot(parsed, snapshotAt);
    const rows = orgIds.length === 0
      ? []
      : await db.execute<DesiredConfigurationRow>(pageQuery(sourceQuery(resource, principal, parsed), parsed));
    const normalizedRows = rows.map((row) => {
      const normalized = normalizeSourceRow<DesiredConfigurationRow>(row);
      if (resource !== 'configuration-policies') {
        return { ...normalized, definition: row.definition, exportPreflightBlocked: false };
      }
      const canonicalized = canonicalizePolicyPatchSettings(row.definition);
      return {
        ...normalized,
        definition: canonicalized.safe ? canonicalized.definition : {},
        exportPreflightBlocked: !canonicalized.safe,
      };
    });
    const envelope = buildEnvelope({
      resource,
      partnerId: principal.partnerId,
      rows: normalizedRows,
      query: parsed,
      preflightBlock: (row) => row.exportPreflightBlocked ? ['features'] : null,
      makeRecord: (row) => ({
        id: row.id,
        orgId: row.orgId,
        siteId: null,
        sourceUpdatedAt: row.updatedAt,
        ...(row.definition as Record<string, unknown>),
      }),
    });
    return c.json(schema.parse(envelope));
  } catch (error) {
    if (isKnownClientError(error)) return clientError(c, error);
    return c.json({ error: CONFIGURATION_FAILURE[resource], code: 'partner_export_failed' }, 500);
  }
}

export const partnerConfigurationRoutes = new Hono();

partnerConfigurationRoutes.get('/configuration-policies', requirePartnerApiScope('configuration:read'), (c) =>
  exportResource(c, 'configuration-policies', configurationPolicyExportEnvelopeSchema));
partnerConfigurationRoutes.get('/configuration-assignments', requirePartnerApiScope('configuration:read'), (c) =>
  exportResource(c, 'configuration-assignments', configurationAssignmentExportEnvelopeSchema));
partnerConfigurationRoutes.get('/scripts', requirePartnerApiScope('scripts:read'), (c) =>
  exportResource(c, 'scripts', scriptExportEnvelopeSchema));
partnerConfigurationRoutes.get('/automations', requirePartnerApiScope('configuration:read'), (c) =>
  exportResource(c, 'automations', automationExportEnvelopeSchema));
partnerConfigurationRoutes.get('/backup-configurations', requirePartnerApiScope('backup-configuration:read'), (c) =>
  exportResource(c, 'backup-configurations', backupConfigurationExportEnvelopeSchema));
partnerConfigurationRoutes.get('/custom-fields', requirePartnerApiScope('custom-fields:read'), (c) =>
  exportResource(c, 'custom-fields', customFieldExportEnvelopeSchema));
partnerConfigurationRoutes.get('/custom-field-values', requirePartnerApiScope('custom-fields:read'), (c) =>
  exportResource(c, 'custom-field-values', customFieldValueExportEnvelopeSchema));
