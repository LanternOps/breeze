/** W15 PR A: partner Pax8 reads and local subscription links, through the REST services. */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, runOutsideDbContext, withDbAccessContext, type DbAccessContext } from '../db';
import { contractLines, organizations, pax8CompanyMappings, pax8ContractLineLinks, pax8Integrations, pax8SubscriptionSnapshots } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { enqueuePax8Sync } from '../jobs/pax8SyncWorker';
import { mfaGatedToolError } from './aiToolMfaGate';
import { pax8ToolSchemas } from './aiToolSchemasPax8';
import { pageEnvelope, readPageArgs } from './aiToolPagination';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { Pax8ApiError } from './pax8Client';
import { getPax8ProductPricing, Pax8CatalogError } from './pax8CatalogService';
import { CatalogServiceError } from './catalogService';
import { pax8CompanyOrderReadiness } from './pax8CompanyReadiness';
import { detectPax8Drift } from './pax8Drift';
import { listPax8Products, Pax8OrderError, snapshotActiveCommitmentEvidence } from './pax8OrderService';
import { createPax8ClientForIntegration, linkPax8SubscriptionToContractLine, unlinkPax8Subscription } from './pax8SyncService';
import { auditToolWrite, bounded, deviceBoundDenied, jsonError, notFound, thrown } from './aiToolsSoftwareShared';

const PAX8_NOT_CONFIGURED_MESSAGE = 'Pax8 is not configured. Connect an active integration with valid credentials.';

/** Credential decoding can throw plain crypto Errors before the client exists. */
async function withPax8ConfigurationErrors<T>(resolve: () => Promise<T>): Promise<T> {
  try { return await resolve(); }
  catch (error) {
    if (error instanceof Error && error.constructor === Error) {
      throw new Pax8CatalogError(PAX8_NOT_CONFIGURED_MESSAGE, 400, 'PAX8_NOT_CONFIGURED');
    }
    throw error;
  }
}

/** The same partner resolver as both REST modules, plus W15's device ceiling. */
export function pax8Partner(auth: AuthContext, requested: unknown): { partnerId: string } | { refusal: string } {
  if (auth.scope === 'organization') return { refusal: jsonError('Pax8 is managed at partner scope', 'PARTNER_SCOPE_REQUIRED') };
  const device = deviceBoundDenied(auth, 'Pax8');
  if (device) return { refusal: device };
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { refusal: jsonError('Partner context required', 'PARTNER_SCOPE_REQUIRED') };
    if (requested && requested !== auth.partnerId) return { refusal: jsonError('Access to this partner denied', 'FORBIDDEN') };
    return { partnerId: auth.partnerId };
  }
  if (typeof requested !== 'string' || !requested) return { refusal: jsonError('partnerId is required for system scope', 'VALIDATION_ERROR') };
  return { partnerId: requested };
}
export function pax8DbContext(auth: AuthContext, partnerId: string): DbAccessContext {
  const system = auth.scope === 'system';
  return { scope: system ? 'system' : 'partner', orgId: null, accessibleOrgIds: system ? null : auth.accessibleOrgIds,
    accessiblePartnerIds: system ? null : [partnerId], userId: auth.user.id, currentPartnerId: partnerId };
}
export function pax8Clip(value: string | null | undefined): string | null {
  if (value == null) return null;
  // Walk code points so a truncated UTF-8 character cannot expand into a three-byte replacement.
  let result = '', bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character, 'utf8');
    if (bytes > 2048) break;
    result += character;
  }
  return result;
}
export function pax8Error(tool: string, error: unknown): string {
  if (error instanceof Pax8ApiError) return jsonError(pax8Clip(error.body || error.message) ?? 'Pax8 request failed', 'PAX8_API_ERROR');
  if (error instanceof Pax8CatalogError || error instanceof CatalogServiceError) {
    return jsonError(pax8Clip(error.message)!, error.code ?? (error.status === 404 ? 'NOT_FOUND' : error.status === 403 ? 'FORBIDDEN' : error.status === 409 ? 'CONFLICT' : 'VALIDATION_ERROR'));
  }
  if (error instanceof Pax8OrderError) return jsonError(pax8Clip(error.message)!, error.status === 404 ? 'NOT_FOUND' : error.status === 403 ? 'FORBIDDEN' : 'VALIDATION_ERROR');
  if (error instanceof Error && [
    'Pax8 integration not found', 'Pax8 integration is inactive',
    'Pax8 integration credentials could not be decrypted',
  ].includes(error.message)) {
    return jsonError(PAX8_NOT_CONFIGURED_MESSAGE, 'PAX8_NOT_CONFIGURED');
  }
  return thrown(tool, error);
}
export function pax8InputSchema(schema: z.ZodType): AiTool['definition']['input_schema'] {
  const { $schema: _schema, ...body } = z.toJSONSchema(schema, { io: 'input' });
  return body as AiTool['definition']['input_schema'];
}
export function pax8Page(tool: string, input: Record<string, unknown>, rows: unknown[], maxOffset?: number): string {
  const page = readPageArgs(tool, input, { defaultLimit: 50, maxLimit: 100 });
  if (!page.ok) return jsonError(page.error, page.code);
  return bounded(pageEnvelope({ key: 'data', items: rows.slice(page.offset, page.offset + page.limit), ...page, total: rows.length, maxOffset }));
}
export async function pax8Integration(partnerId: string, integrationId?: string) {
  const conditions = [eq(pax8Integrations.partnerId, partnerId), eq(pax8Integrations.isActive, true)];
  if (integrationId) conditions.push(eq(pax8Integrations.id, integrationId));
  const [row] = await db.select({
    id: pax8Integrations.id, name: pax8Integrations.name, apiBaseUrl: pax8Integrations.apiBaseUrl, tokenUrl: pax8Integrations.tokenUrl,
    isActive: pax8Integrations.isActive, lastSyncAt: pax8Integrations.lastSyncAt, lastSyncStatus: pax8Integrations.lastSyncStatus,
    lastSyncError: pax8Integrations.lastSyncError,
    hasClientId: sql<boolean>`(${pax8Integrations.clientIdEncrypted} is not null and ${pax8Integrations.clientIdEncrypted} != '')`,
    hasClientSecret: sql<boolean>`(${pax8Integrations.clientSecretEncrypted} is not null and ${pax8Integrations.clientSecretEncrypted} != '')`,
    hasWebhookSecret: sql<boolean>`(${pax8Integrations.webhookSecretEncrypted} is not null and ${pax8Integrations.webhookSecretEncrypted} != '')`,
  }).from(pax8Integrations).where(and(...conditions)).limit(1);
  return row ?? null;
}
function presentIntegration(row: NonNullable<Awaited<ReturnType<typeof pax8Integration>>>) {
  return { id: row.id, name: row.name, apiBaseUrl: row.apiBaseUrl, tokenUrl: row.tokenUrl, isActive: row.isActive,
    lastSyncAt: row.lastSyncAt, lastSyncStatus: row.lastSyncStatus, lastSyncError: pax8Clip(row.lastSyncError),
    hasClientId: row.hasClientId, hasClientSecret: row.hasClientSecret, hasWebhookSecret: row.hasWebhookSecret };
}
async function companies(partnerId: string, integrationId?: string) {
  const integration = await pax8Integration(partnerId, integrationId);
  if (!integration) return notFound('Pax8 integration');
  const rows = await db.select({ pax8CompanyId: pax8CompanyMappings.pax8CompanyId, pax8CompanyName: pax8CompanyMappings.pax8CompanyName,
    status: pax8CompanyMappings.status, mappedOrgId: pax8CompanyMappings.orgId, mappedOrgName: organizations.name,
    ignored: pax8CompanyMappings.ignored, lastSeenAt: pax8CompanyMappings.lastSeenAt, metadata: pax8CompanyMappings.metadata,
  }).from(pax8CompanyMappings).leftJoin(organizations, eq(pax8CompanyMappings.orgId, organizations.id))
    .where(and(eq(pax8CompanyMappings.integrationId, integration.id), eq(pax8CompanyMappings.partnerId, partnerId)))
    .orderBy(pax8CompanyMappings.pax8CompanyName, pax8CompanyMappings.pax8CompanyId);
  return rows.map(({ metadata, ...row }) => ({ ...row, ...pax8CompanyOrderReadiness(row.status, metadata) }));
}
async function subscriptions(partnerId: string, input: Record<string, unknown>, auth: AuthContext, integrationId: string) {
  const conditions: SQL[] = [eq(pax8SubscriptionSnapshots.integrationId, integrationId), eq(pax8SubscriptionSnapshots.partnerId, partnerId)];
  if (typeof input.orgId === 'string') {
    if (!auth.canAccessOrg(input.orgId)) return jsonError('Access to organization denied', 'FORBIDDEN');
    conditions.push(eq(pax8SubscriptionSnapshots.orgId, input.orgId));
  } else if (input.unmappedOnly !== true) {
    const org = auth.orgCondition(pax8SubscriptionSnapshots.orgId); if (org) conditions.push(org);
  }
  if (input.unmappedOnly === true) conditions.push(sql`${pax8SubscriptionSnapshots.orgId} is null`);
  const p = readPageArgs('manage_pax8_subscriptions', input, { defaultLimit: 50, maxLimit: 100 });
  if (!p.ok) return jsonError(p.error, p.code);
  const rows = await db.select({
    id: pax8SubscriptionSnapshots.id, pax8SubscriptionId: pax8SubscriptionSnapshots.pax8SubscriptionId,
    pax8CompanyId: pax8SubscriptionSnapshots.pax8CompanyId, pax8CompanyName: pax8CompanyMappings.pax8CompanyName,
    orgId: pax8SubscriptionSnapshots.orgId, productId: pax8SubscriptionSnapshots.productId, productName: pax8SubscriptionSnapshots.productName,
    vendorName: pax8SubscriptionSnapshots.vendorName, vendorSkuId: pax8SubscriptionSnapshots.vendorSkuId,
    status: pax8SubscriptionSnapshots.status, billingTerm: pax8SubscriptionSnapshots.billingTerm, quantity: pax8SubscriptionSnapshots.quantity,
    quantityKnown: pax8SubscriptionSnapshots.quantityKnown, unitPrice: pax8SubscriptionSnapshots.unitPrice, unitCost: pax8SubscriptionSnapshots.unitCost,
    currencyCode: pax8SubscriptionSnapshots.currencyCode, lastSeenAt: pax8SubscriptionSnapshots.lastSeenAt,
    contractLineId: pax8ContractLineLinks.contractLineId, breezeQuantity: contractLines.manualQuantity,
    syncEnabled: pax8ContractLineLinks.syncEnabled, lastObservedQuantity: pax8ContractLineLinks.lastObservedQuantity,
    lastObservedAt: pax8ContractLineLinks.lastObservedAt, raw: pax8SubscriptionSnapshots.raw,
  }).from(pax8SubscriptionSnapshots)
    .leftJoin(pax8CompanyMappings, and(eq(pax8SubscriptionSnapshots.integrationId, pax8CompanyMappings.integrationId), eq(pax8SubscriptionSnapshots.pax8CompanyId, pax8CompanyMappings.pax8CompanyId)))
    .leftJoin(pax8ContractLineLinks, eq(pax8SubscriptionSnapshots.id, pax8ContractLineLinks.subscriptionSnapshotId))
    .leftJoin(contractLines, and(eq(pax8ContractLineLinks.contractLineId, contractLines.id), eq(pax8ContractLineLinks.orgId, contractLines.orgId), eq(pax8SubscriptionSnapshots.orgId, contractLines.orgId)))
    .where(and(...conditions)).orderBy(desc(pax8SubscriptionSnapshots.lastSeenAt), pax8SubscriptionSnapshots.id).limit(p.limit + 1).offset(p.offset);
  return bounded(pageEnvelope({ key: 'data', items: rows.map(({ raw, ...row }) => ({ ...row, ...snapshotActiveCommitmentEvidence(raw) })), ...p }));
}
async function subscriptionAction(input: Record<string, unknown>, auth: AuthContext, partnerId: string): Promise<string> {
  const integration = await pax8Integration(partnerId, input.integrationId as string | undefined);
  if (!integration) return notFound('Pax8 integration');
  const action = String(input.action);
  if (action === 'list') return subscriptions(partnerId, input, auth, integration.id);
  if (action === 'drift') return pax8Page('manage_pax8_subscriptions', input, (await detectPax8Drift({ partnerId, integrationId: integration.id })).filter(row => auth.canAccessOrg(row.orgId)));
  if (action === 'sync') {
    const jobId = await enqueuePax8Sync(integration.id);
    auditToolWrite(auth, { orgId: null, partnerId, action: 'pax8.integration.sync', resourceType: 'pax8_integration', resourceId: integration.id, details: { tool_name: 'manage_pax8_subscriptions', jobId } });
    return bounded({ queued: true, jobId, integrationId: integration.id });
  }
  if (typeof input.subscriptionSnapshotId !== 'string') return jsonError('subscriptionSnapshotId is required', 'VALIDATION_ERROR');
  const [snapshot] = await db.select({ orgId: pax8SubscriptionSnapshots.orgId, integrationId: pax8SubscriptionSnapshots.integrationId })
    .from(pax8SubscriptionSnapshots).where(and(eq(pax8SubscriptionSnapshots.id, input.subscriptionSnapshotId), eq(pax8SubscriptionSnapshots.partnerId, partnerId))).limit(1);
  if (!snapshot || snapshot.integrationId !== integration.id) return notFound('Pax8 subscription');
  if (snapshot.orgId && !auth.canAccessOrg(snapshot.orgId)) return jsonError('Access to subscription denied', 'FORBIDDEN');
  let data: unknown;
  if (action === 'link') {
    if (typeof input.contractLineId !== 'string') return jsonError('contractLineId is required', 'VALIDATION_ERROR');
    const [line] = await db.select({ orgId: contractLines.orgId }).from(contractLines).where(eq(contractLines.id, input.contractLineId)).limit(1);
    if (!line || !auth.canAccessOrg(line.orgId)) return jsonError('Access to contract line denied', 'FORBIDDEN');
    try {
      data = await linkPax8SubscriptionToContractLine({ partnerId, integrationId: integration.id, subscriptionSnapshotId: input.subscriptionSnapshotId, contractLineId: input.contractLineId, syncEnabled: input.syncEnabled === true });
    } catch (error) {
      // The REST service uses plain Errors for expected local link validation.
      if (error instanceof Error && error.constructor === Error) return jsonError(pax8Clip(error.message)!, 'VALIDATION_ERROR');
      throw error;
    }
  } else data = await unlinkPax8Subscription({ integrationId: integration.id, subscriptionSnapshotId: input.subscriptionSnapshotId });
  auditToolWrite(auth, { orgId: snapshot.orgId, partnerId, action: action === 'link' ? 'pax8.subscription.link_contract_line' : 'pax8.subscription.unlink_contract_line', resourceType: 'pax8_subscription_snapshot', resourceId: input.subscriptionSnapshotId, details: { integrationId: integration.id, tool_name: 'manage_pax8_subscriptions', ...(action === 'link' ? { contractLineId: input.contractLineId, syncEnabled: input.syncEnabled === true } : {}) } });
  return bounded({ data });
}
export function registerPax8Tools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_pax8_status', {
    tier: 1, deviceArgs: [], domain: 'billing', searchHint: 'Pax8 integration health and company readiness',
    definition: { name: 'get_pax8_status', description: 'Pax8 integration summary or companies and order readiness. Partner-wide billing access required.', input_schema: pax8InputSchema(pax8ToolSchemas.get_pax8_status) },
    handler: async (input, auth) => {
      const partner = pax8Partner(auth, input.partnerId); if ('refusal' in partner) return partner.refusal;
      if (!canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 'ACCESS_DENIED');
      try {
        if (input.view === 'companies') {
          const rows = await companies(partner.partnerId, input.integrationId as string | undefined);
          return typeof rows === 'string' ? rows : pax8Page('get_pax8_status', input, rows);
        }
        const integration = await pax8Integration(partner.partnerId, input.integrationId as string | undefined);
        return bounded({ data: integration ? presentIntegration(integration) : null });
      } catch (error) { return pax8Error('get_pax8_status', error); }
    },
  });
  aiTools.set('search_pax8_products', {
    tier: 1, deviceArgs: [], domain: 'billing', searchHint: 'Pax8 mapped products, live pricing, commitments and provisioning fields',
    selfManagedDbContext: ['provision_details', 'dependencies', 'pricing'],
    definition: { name: 'search_pax8_products', description: 'Pax8 products: search local mapped catalog products; provision_details, dependencies and pricing read live product metadata.', input_schema: pax8InputSchema(pax8ToolSchemas.search_pax8_products) },
    handler: async (input, auth) => {
      const partner = pax8Partner(auth, input.partnerId); if ('refusal' in partner) return partner.refusal;
      try {
        if (input.action === 'search') {
          const rows = await listPax8Products({ partnerId: partner.partnerId });
          const q = String(input.q ?? '').toLowerCase();
          return pax8Page('search_pax8_products', input, rows.filter(row => [row.catalogName, row.productName, row.vendorSkuId, row.catalogSku].some(v => v?.toLowerCase().includes(q))), 200);
        }
        if (typeof input.productId !== 'string') return jsonError('productId is required', 'VALIDATION_ERROR');
        if (input.action === 'pricing') {
          const rows = await withPax8ConfigurationErrors(() => getPax8ProductPricing(input.productId as string, { partnerId: partner.partnerId, userId: auth.user.id, accessibleOrgIds: auth.accessibleOrgIds }, pax8DbContext(auth, partner.partnerId)));
          return bounded({ data: rows.map(({ raw: _raw, ...row }) => row) });
        }
        const created = await runOutsideDbContext(() => withDbAccessContext(pax8DbContext(auth, partner.partnerId), async () => {
          const integration = await pax8Integration(partner.partnerId);
          if (!integration) throw new Pax8OrderError('Pax8 integration not found', 404);
          return withPax8ConfigurationErrors(() => createPax8ClientForIntegration(integration.id));
        }));
        if (created.integration.partnerId !== partner.partnerId) return notFound('Pax8 integration');
        const data = await runOutsideDbContext(() => input.action === 'provision_details'
          ? created.client.getProvisionDetails(input.productId as string) : created.client.getProductDependencies(input.productId as string));
        return bounded({ data });
      } catch (error) { return pax8Error('search_pax8_products', error); }
    },
  });
  aiTools.set('manage_pax8_subscriptions', {
    tier: 1, deviceArgs: [], domain: 'billing', searchHint: 'Pax8 subscription seats, billing quantity drift, sync and contract links',
    definition: { name: 'manage_pax8_subscriptions', description: 'Pax8 subscriptions: list, drift, sync, link and unlink. Sync and contract links need supervised approval; linking selects later billed contract lines.', input_schema: pax8InputSchema(pax8ToolSchemas.manage_pax8_subscriptions) },
    handler: async (input, auth) => {
      const partner = pax8Partner(auth, input.partnerId); if ('refusal' in partner) return partner.refusal;
      if (!canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 'ACCESS_DENIED');
      const mfa = mfaGatedToolError('manage_pax8_subscriptions', String(input.action), auth); if (mfa) return mfa;
      try { return await subscriptionAction(input, auth, partner.partnerId); }
      catch (error) { return pax8Error('manage_pax8_subscriptions', error); }
    },
  });
}
