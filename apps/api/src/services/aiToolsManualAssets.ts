/**
 * `manage_manual_assets` (full-control W13, #6783, PR A): the AI twin of the
 * manual-asset routes (routes/devices/manual.ts) — hand-entered, non-networked
 * inventory rows. Every action runs the route's own logic in
 * `services/manualAssetOps.ts` (moved verbatim, W13-D3) and the route's own
 * zod body schemas.
 *
 *  - list (t1); create / update / link / unlink (t2: reversible,
 *    tenant-internal, one record); delete (supervised: a hard delete with no
 *    restore — PATCH `retiredAt` is the soft path).
 *  - Site axis: the caller's site allowlist, exactly as REST applies it.
 *  - Exact-device axis (W13-D12, quorum QW5): a manual asset belongs to no
 *    device, so a session bound to specific devices is refused every action.
 *  - `created_by` / `updated_by` are `users` FKs: a verified user or NULL
 *    (W13-D5). Every write's REST twin carries `requireMfa()` (W13-D6).
 */
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import type { RouteAuditInput } from './auditEvents';
import { mfaGatedToolError } from './aiToolMfaGate';
import { siteAllowlistOf } from './aiToolsSiteScope';
import {
  createManualAsset, deleteManualAsset, linkManualAsset, listManualAssets, unlinkManualAsset, updateManualAsset,
  type ManualAssetOpResult,
} from './manualAssetOps';
import { createManualAssetSchema, linkManualAssetSchema, updateManualAssetSchema } from '../routes/devices/schemas';
import { MANUAL_ASSET_ACTIONS } from './aiToolSchemasDeviceOps';
import { auditToolWrite, bounded, clampLimit, jsonError, thrown, verifiedUserIdOrNull } from './aiToolsSoftwareShared';

type Action = (typeof MANUAL_ASSET_ACTIONS)[number];

const WRITE_FIELDS = [
  'siteId', 'name', 'assetType', 'manufacturer', 'model', 'serialNumber', 'assetTag', 'location',
  'assignedContactId', 'notes', 'tags', 'purchaseDate',
] as const;

/** The manual-asset fields of the unified-list DTO (the device-only nulls are dropped). */
const MANUAL_FIELDS = [
  'id', 'assetType', 'orgId', 'siteId', 'displayName', 'tags', 'manufacturer', 'model', 'notes', 'retiredAt',
  'linkedDeviceId', 'linkedDiscoveredAssetId', 'serialNumber', 'assetTag', 'location', 'assignedContactId',
  'purchaseDate', 'purchaseDateSource', 'enrolledAt',
] as const;

export function projectManualAsset(dto: unknown): Record<string, unknown> {
  if (!dto || typeof dto !== 'object') return {};
  const row = dto as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of MANUAL_FIELDS) if (key in row) out[key === 'displayName' ? 'name' : key] = row[key];
  return out;
}

function toolResult(result: ManualAssetOpResult, project: (body: Record<string, unknown>) => unknown): string {
  if (result.status >= 200 && result.status < 300) return bounded(project(result.body));
  const message = typeof result.body.error === 'string' ? result.body.error : `Request failed (${result.status})`;
  const code = result.status === 404 ? 'NOT_FOUND' : result.status === 403 ? 'ACCESS_DENIED'
    : result.status === 409 ? 'CONFLICT' : result.status === 400 ? 'VALIDATION_ERROR' : 'FAILED';
  return jsonError(message, code);
}

function siteAllowedFor(auth: AuthContext): (siteId: string) => boolean {
  const allowed = siteAllowlistOf(auth);
  return (siteId) => allowed === undefined || allowed.includes(siteId);
}

function pick(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (input[key] !== undefined) out[key] = input[key];
  return out;
}

export function registerManualAssetTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_manual_assets', {
    tier: 1,
    domain: 'devices',
    searchHint: 'hand-entered inventory without an agent (spare laptops, phones, printers): list, add, edit, link, delete',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_manual_assets',
      description: 'Actions: list, create, update, delete, link, unlink hand-entered inventory rows. update with retiredAt retires; delete is permanent and needs approval; link to a deviceId or discoveredAssetId.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...MANUAL_ASSET_ACTIONS], description: 'The action to perform' },
          assetId: { type: 'string', description: 'update / delete / link / unlink: manual asset UUID' },
          orgId: { type: 'string', description: 'list: filter; create: owning organization' },
          siteId: { type: 'string', description: 'list: filter; create / update: site' },
          search: { type: 'string', description: 'list: name / serial / tag text' },
          page: { type: 'number', description: 'list: page (default 1)' },
          limit: { type: 'number', description: 'Max assets per page, list only (default 50, max 100)' },
          name: { type: 'string', description: 'create / update: asset name' },
          assetType: { type: 'string', description: 'create / update: asset type (e.g. workstation, printer, phone)' },
          manufacturer: { type: ['string', 'null'], description: 'create / update' },
          model: { type: ['string', 'null'], description: 'create / update' },
          serialNumber: { type: ['string', 'null'], description: 'create / update' },
          assetTag: { type: ['string', 'null'], description: 'create / update' },
          location: { type: ['string', 'null'], description: 'create / update' },
          assignedContactId: { type: ['string', 'null'], description: 'create / update: contact UUID' },
          notes: { type: ['string', 'null'], description: 'create / update' },
          tags: { type: 'array', items: { type: 'string' }, description: 'create / update' },
          purchaseDate: { type: ['string', 'null'], description: 'create / update: YYYY-MM-DD' },
          retiredAt: { type: ['string', 'null'], description: 'update: ISO datetime retires; null un-retires' },
          deviceId: { type: 'string', description: 'link: agent device UUID' },
          discoveredAssetId: { type: 'string', description: 'link: discovered asset UUID' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!MANUAL_ASSET_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      if (auth.allowedDeviceIds !== undefined) {
        return jsonError('Manual assets belong to no device; a session bound to specific devices cannot use them', 'ACCESS_DENIED');
      }
      if (action !== 'list') {
        const mfa = mfaGatedToolError('manage_manual_assets', action, auth);
        if (mfa) return mfa;
      }
      const siteAllowed = siteAllowedFor(auth);
      const audit = (event: RouteAuditInput) => auditToolWrite(auth, {
        orgId: event.orgId ?? null,
        action: event.action,
        resourceType: event.resourceType,
        ...(event.resourceId ? { resourceId: event.resourceId } : {}),
        ...(event.resourceName ? { resourceName: event.resourceName } : {}),
        ...(event.details ? { details: event.details } : {}),
      });
      const one = (body: Record<string, unknown>) => projectManualAsset(body);
      try {
        if (action === 'list') {
          const allowed = siteAllowlistOf(auth);
          const result = await listManualAssets({
            auth,
            query: {
              page: String(clampLimit(input.page, 1, 10000)),
              limit: String(clampLimit(input.limit, 50, 100)),
              ...(typeof input.orgId === 'string' ? { orgId: input.orgId } : {}),
              ...(typeof input.siteId === 'string' ? { siteId: input.siteId } : {}),
              ...(typeof input.search === 'string' ? { search: input.search } : {}),
              ...(typeof input.assetType === 'string' ? { assetType: input.assetType as never } : {}),
            },
            allowedSiteIds: allowed === undefined ? null : [...allowed],
            siteAllowed,
          });
          return toolResult(result, (body) => ({
            assets: Array.isArray(body.data) ? body.data.map(projectManualAsset) : [],
            pagination: body.pagination,
          }));
        }

        if (action === 'create') {
          const orgId = typeof input.orgId === 'string' ? input.orgId : (auth.scope === 'organization' ? auth.orgId : undefined);
          const parsed = createManualAssetSchema.safeParse({ ...pick(input, WRITE_FIELDS), orgId });
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input', 'VALIDATION_ERROR');
          const result = await createManualAsset({
            auth, actorUserId: await verifiedUserIdOrNull(auth), data: parsed.data, siteAllowed, audit,
          });
          return toolResult(result, (body) => ({
            asset: one(body),
            ...(body.warning !== undefined ? { warning: body.warning } : {}),
          }));
        }

        if (typeof input.assetId !== 'string') return jsonError('assetId is required', 'VALIDATION_ERROR');
        const id = input.assetId;

        if (action === 'update') {
          const parsed = updateManualAssetSchema.safeParse(pick(input, [...WRITE_FIELDS, 'retiredAt']));
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input', 'VALIDATION_ERROR');
          if (Object.keys(parsed.data).length === 0) return jsonError('Nothing to update', 'VALIDATION_ERROR');
          const result = await updateManualAsset({
            auth, actorUserId: await verifiedUserIdOrNull(auth), id, data: parsed.data, siteAllowed, audit,
          });
          return toolResult(result, (body) => ({ asset: one(body) }));
        }
        if (action === 'delete') {
          const result = await deleteManualAsset({ auth, id, siteAllowed, audit });
          return toolResult(result, () => ({ deleted: true, assetId: id }));
        }
        if (action === 'link') {
          const parsed = linkManualAssetSchema.safeParse(pick(input, ['deviceId', 'discoveredAssetId']));
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input', 'VALIDATION_ERROR');
          const result = await linkManualAsset({
            auth, actorUserId: await verifiedUserIdOrNull(auth), id, body: parsed.data, siteAllowed, audit,
          });
          return toolResult(result, (body) => ({ asset: one(body) }));
        }
        const result = await unlinkManualAsset({ auth, actorUserId: await verifiedUserIdOrNull(auth), id, siteAllowed, audit });
        return toolResult(result, (body) => ({ asset: one(body) }));
      } catch (error) {
        return thrown('manage_manual_assets', error);
      }
    },
  });
}
