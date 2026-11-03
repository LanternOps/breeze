/**
 * `manage_accounting_sync` (full-control W14 PR B, #6784): the AI twin of the
 * interactive accounting routes (routes/accounting/index.ts) through the same
 * services. One partner-wide provider realm (QuickBooks or Xero) per partner.
 *
 * Classes (W14 plan PR B table + PR B quorum):
 *  - t1 reads: status, owed_operations, customers, mappings, income_accounts,
 *    remote_candidates. The remote-candidates search term is NEVER sent to the
 *    provider (quorum QW8): the tool lists without a term and filters locally.
 *  - supervised: link_mapping (decision `confirmed`; like PUT /mappings it
 *    enqueues the sync, which OVERWRITES the linked remote customer / item with
 *    Breeze's values), unlink_mapping (local), sync_mapping (re-send a LINKED
 *    mapping — an update; a sync that would create the remote record is refused).
 *  - four-eyes: push and push_bulk (the invoice leaves the tenant and exists in
 *    the books; a push also syncs a not-yet-synced customer / item, QW1). Both
 *    have mandatory EFFECT_DIGEST_RESOLVERS pins, and push_bulk pushes
 *    synchronously at release instead of queueing (PR B quorum QB5).
 *  - not built: `create_new` (create the record in the provider). Its job and
 *    the stale-row sweep (jobs/accountingSyncWorker.ts) reload live rows long
 *    after any approval, so no approval could bind what it creates (QB5); it
 *    stays in the web mapping workbench.
 *
 * Gates (REST parity, re-made at release because the handler runs then):
 * partner or system scope, full-partner authority (canManagePartnerWidePolicies
 * — requireAccountingPartnerAuthority), the provider gate (registered, has the
 * capability, configured), MFA on every write. Permissions are in
 * TOOL_PERMISSIONS / TOOL_ACTION_EXTRA_PERMISSIONS: mapping writes require BOTH
 * organizations:write and catalog:write (REST asks for the entity's one; the
 * tool has no input-aware permission rows, so it asks for both — a tightening).
 *
 * Output: never a token column (status is an explicit projection; the live
 * connection that carries the decrypted token is only ever an argument), remote
 * names fenced as raw text, mapping rows through the route's own projection.
 *
 * Not built (W14 plan / PR B quorum): connect, callback, disconnect, settings
 * and refresh, tenant selection (vendor console); customer import (creates
 * organizations — the manage_organizations:create_org four-eyes precedent;
 * stays in the web import workbench); reconcile.
 */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { accountingConnections, accountingEntityMappings, invoicePayments, invoices } from '../db/schema';
import { withAuthDbAccessContext, type AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { canMutateOrgWideGovernance } from './siteCeilingAccess';
import {
  AccountingMappingError, listMappingProposals, listRemoteIncomeAccountsForPartner, resolveConnectionAndToken,
  saveMappingDecision, syncMappedEntity, type MappingDecision, type MappingEntityType,
} from './accounting/accountingMappingService';
import { AccountingImportError, listAccountingCustomersAnnotated } from './accounting/accountingCustomerImport';
import { pushInvoiceToAccounting } from './accounting/accountingInvoicePush';
import { AccountingInvoicePushError } from './accounting/accountingInvoicePushErrors';
import { accountingProviderDisplayName, findAccountingProvider, getAccountingProvider, providerSupports } from './accounting/providerRegistry';
import {
  isAccountingProviderError, providerPermissionMessage, rateLimitRetryAfterMs, refusalCodeOf,
} from './accounting/accountingProviderError';
import { captureException } from './sentry';
import type { AccountingCapability, AccountingProviderId } from './accounting/types';
import { enqueueAccountingMappingSync } from '../jobs/accountingSyncWorker';
import { ACCOUNTING_PROVIDERS, ACCOUNTING_SYNC_ACTIONS, ACCOUNTING_PUSH_BULK_MAX } from './aiToolSchemasBilling';
import { auditToolWrite, bounded, jsonError, notFound, thrown } from './aiToolsSoftwareShared';

type Action = (typeof ACCOUNTING_SYNC_ACTIONS)[number];
const TOOL = 'manage_accounting_sync';
/** Local remote-candidate filter cap (the route returns the provider's whole match list). */
const CANDIDATE_LIMIT = 25;

/** Which provider capability each action needs (the route's providerGateResponse call). */
const CAPABILITY: Readonly<Record<Action, { cap: AccountingCapability; requireConfigured: boolean }>> = {
  status: { cap: 'connect', requireConfigured: false },
  owed_operations: { cap: 'paymentPush', requireConfigured: false },
  customers: { cap: 'customerImport', requireConfigured: true },
  mappings: { cap: 'mapping', requireConfigured: true },
  income_accounts: { cap: 'mapping', requireConfigured: true },
  remote_candidates: { cap: 'mapping', requireConfigured: true },
  link_mapping: { cap: 'mapping', requireConfigured: true },
  unlink_mapping: { cap: 'mapping', requireConfigured: true },
  sync_mapping: { cap: 'mapping', requireConfigured: true },
  push: { cap: 'invoicePush', requireConfigured: true },
  push_bulk: { cap: 'invoicePush', requireConfigured: true },
};

/** requireScope('partner', 'system') + requireAccountingPartnerAuthority. Returns the partner, or the refusal. */
function partnerOrRefusal(auth: AuthContext): { partnerId: string } | { refusal: string } {
  // The partner is the session's own; the tool takes no partnerId (REST's system-scope ?partnerId is not offered).
  const partnerId = auth.scope === 'partner' || auth.scope === 'system' ? auth.partnerId ?? null : null;
  if (!partnerId) {
    return { refusal: jsonError('Accounting integrations are managed at partner scope', 'PARTNER_SCOPE_REQUIRED') };
  }
  if (!canManagePartnerWidePolicies(auth)) {
    return { refusal: jsonError('Full partner organization access is required', 'ACCESS_DENIED') };
  }
  return { partnerId };
}

function providerRefusal(provider: AccountingProviderId, action: Action): string | null {
  const impl = findAccountingProvider(provider);
  if (!impl) return jsonError(`${provider} is not available on this instance yet`, 'capability_unavailable');
  const { cap, requireConfigured } = CAPABILITY[action];
  if (!providerSupports(provider, cap)) return jsonError(`${impl.displayName} does not support this yet`, 'capability_unavailable');
  if (requireConfigured) {
    const configError = impl.configError();
    if (configError) return jsonError(configError, 'provider_not_configured');
  }
  return null;
}

type CodedError = { error: string; code: string; details?: unknown; retryAfterSeconds?: number };

/** Provider fault kinds the model can act on, each with its own code (REST: routeErrors.ts + handleMappingError). */
const PROVIDER_KIND_CODES: Readonly<Record<string, string>> = {
  reauth: 'provider_reauth_required',
  validation: 'provider_validation',
  not_found: 'provider_not_found',
  stale_version: 'provider_stale_version',
  payment_linked: 'provider_payment_linked',
  duplicate_doc_number: 'provider_duplicate_doc_number',
  transient: 'provider_transient',
};

/**
 * The route's error mapping (routeErrors.ts / handleInvoicePushError), as an object (review: one copy, no JSON
 * round trip, so push_bulk keeps details and the retry hint). Null for an error this tool does not own.
 */
function serviceErrorBody(err: unknown): CodedError | null {
  const retryAfterMs = rateLimitRetryAfterMs(err);
  const retry = retryAfterMs !== null ? { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) } : {};
  if (err instanceof AccountingMappingError || err instanceof AccountingImportError || err instanceof AccountingInvoicePushError) {
    const details = (err as { details?: unknown }).details;
    return { error: err.message, code: err.code, ...(details ? { details } : {}), ...retry };
  }
  if (refusalCodeOf(err) === 'insufficient_scope' && isAccountingProviderError(err)) {
    return { error: providerPermissionMessage(accountingProviderDisplayName(err.provider)), code: 'provider_permission' };
  }
  if (isAccountingProviderError(err)) {
    if (retryAfterMs !== null) return { error: 'The accounting provider is rate limiting requests; try again shortly', code: 'rate_limited', ...retry };
    // A raw provider fault (remote_candidates calls the provider directly): log the server-side body, return the
    // PII-free fault class (providerMessage is the class, never the provider's Detail).
    console.error(`[${TOOL}] provider error`, err.provider, err.operation, err.kind, err.logBody ?? '');
    const label = accountingProviderDisplayName(err.provider);
    return {
      error: `${label} returned an error${err.providerMessage ? ` (${err.providerMessage})` : ''}`,
      code: PROVIDER_KIND_CODES[err.kind] ?? 'provider_error',
    };
  }
  return null;
}

function serviceError(err: unknown): string | null {
  const body = serviceErrorBody(err);
  return body ? JSON.stringify(body) : null;
}

/** A push_bulk refusal that will refuse every later invoice too: stop and report the rest as not attempted. */
const STOPS_BULK: ReadonlySet<string> = new Set(['rate_limited', 'provider_reauth_required', 'provider_permission', 'reauth_required', 'not_connected']);

/** The route's toMappingResponse: never the internal id, connection or optimistic-concurrency token. */
function mappingView(m: {
  breezeEntityType: string; breezeEntityId: string; remoteEntityType: string; remoteEntityId: string | null;
  linkStatus: string; syncStatus: string; lastSyncedAt: Date | null; lastError: string | null;
  confidence: string; proposedRemoteName: string | null;
}) {
  return {
    breezeEntityType: m.breezeEntityType, breezeEntityId: m.breezeEntityId, remoteEntityType: m.remoteEntityType,
    remoteEntityId: m.remoteEntityId, linkStatus: m.linkStatus, syncStatus: m.syncStatus,
    lastSyncedAt: m.lastSyncedAt, lastError: m.lastError, confidence: m.confidence, proposedRemoteName: m.proposedRemoteName,
  };
}

function entityArgs(input: Record<string, unknown>): { entityType: MappingEntityType; entityId: string } | string {
  if (input.entityType !== 'org' && input.entityType !== 'catalog_item') return jsonError('entityType must be org or catalog_item', 'VALIDATION_ERROR');
  if (typeof input.entityId !== 'string') return jsonError('entityId is required', 'VALIDATION_ERROR');
  return { entityType: input.entityType, entityId: input.entityId };
}

async function status(partnerId: string, provider: AccountingProviderId, auth: AuthContext): Promise<string> {
  // An explicit projection: never accessTokenEncrypted / refreshTokenEncrypted / realmIdEncrypted /
  // webhookVerifierTokenEncrypted (aiToolOutput.encryptedColumns), never getConnection (it decrypts).
  const [row] = await withAuthDbAccessContext(auth, () => db.select({
    status: accountingConnections.status, environment: accountingConnections.environment,
    pushMode: accountingConnections.pushMode, connectedAt: accountingConnections.createdAt,
    lastError: accountingConnections.lastError, homeCurrency: accountingConnections.homeCurrency,
    multiCurrencyEnabled: accountingConnections.multiCurrencyEnabled,
    pullPayments: accountingConnections.pullPayments, pushPayments: accountingConnections.pushPayments,
    lastReconcileAt: accountingConnections.lastReconcileAt,
    defaultIncomeAccountRef: accountingConnections.defaultIncomeAccountRef,
    defaultTaxCodeRef: accountingConnections.defaultTaxCodeRef,
    defaultExemptTaxCodeRef: accountingConnections.defaultExemptTaxCodeRef,
    defaultPaymentAccountRef: accountingConnections.defaultPaymentAccountRef,
  }).from(accountingConnections)
    .where(and(eq(accountingConnections.partnerId, partnerId), eq(accountingConnections.provider, provider)))
    .limit(1));
  const impl = getAccountingProvider(provider);
  return bounded({ provider, capabilities: impl.capabilities, connection: row ?? null, status: row?.status ?? 'disconnected' });
}

async function owedOperations(partnerId: string, provider: AccountingProviderId, auth: AuthContext): Promise<string> {
  // Same read as GET /:provider/owed-operations: the payment outbox, joined back to its invoice.
  const invoiceMapping = alias(accountingEntityMappings, 'owed_invoice_mapping');
  const rows = await withAuthDbAccessContext(auth, () => db.select({
    pendingOp: accountingEntityMappings.pendingOp,
    lastError: accountingEntityMappings.lastError,
    pendingSince: sql<Date>`coalesce(${accountingEntityMappings.pendingSince}, ${accountingEntityMappings.createdAt})`.mapWith(accountingEntityMappings.createdAt),
    invoiceId: invoices.id,
    invoiceNumber: invoices.invoiceNumber,
  }).from(accountingEntityMappings)
    .innerJoin(accountingConnections, and(
      eq(accountingConnections.id, accountingEntityMappings.integrationId),
      eq(accountingConnections.partnerId, accountingEntityMappings.partnerId),
      eq(accountingConnections.provider, provider),
    ))
    .leftJoin(invoicePayments, eq(invoicePayments.id, accountingEntityMappings.breezeEntityId))
    .leftJoin(invoiceMapping, and(
      eq(invoiceMapping.integrationId, accountingEntityMappings.integrationId),
      eq(invoiceMapping.partnerId, accountingEntityMappings.partnerId),
      eq(invoiceMapping.breezeEntityType, 'invoice'),
      eq(invoiceMapping.remoteEntityId, sql`split_part(${accountingEntityMappings.remoteEntityId}, '/', 2)`),
    ))
    .leftJoin(invoices, and(
      eq(invoices.id, sql`coalesce(${invoicePayments.invoiceId}, ${invoiceMapping.breezeEntityId})`),
      eq(invoices.partnerId, partnerId),
    ))
    .where(and(
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
      isNotNull(accountingEntityMappings.pendingOp),
    ))
    .orderBy(asc(accountingEntityMappings.pendingSince), asc(accountingEntityMappings.id))
    .limit(200));
  return bounded({ count: rows.length, operations: rows });
}

async function remoteCandidates(partnerId: string, provider: AccountingProviderId, input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  if (input.entityType !== 'org' && input.entityType !== 'catalog_item') return jsonError('entityType must be org or catalog_item', 'VALIDATION_ERROR');
  // Quorum QW8: a model-chosen term never reaches the provider. List without one and filter here.
  const term = typeof input.q === 'string' ? input.q.trim().toLowerCase() : '';
  const { liveConn } = await resolveConnectionAndToken(partnerId, { provider }, (fn) => withAuthDbAccessContext(auth, fn));
  const impl = getAccountingProvider(provider);
  const rows = input.entityType === 'org'
    ? (await impl.listRemoteCustomers(liveConn)).map((r) => ({
      id: r.id, displayName: r.displayName, currencyCode: r.currencyCode ?? null, archived: r.active === false, sku: null as string | null,
    }))
    : (await impl.listRemoteItems(liveConn)).map((r) => ({
      id: r.id, displayName: r.displayName, currencyCode: null as string | null, archived: r.active === false, sku: r.sku ?? null,
    }));
  const matches = term
    ? rows.filter((r) => r.displayName.toLowerCase().includes(term) || (r.sku ?? '').toLowerCase().includes(term))
    : rows;
  return bounded({ total: matches.length, candidates: matches.slice(0, CANDIDATE_LIMIT), truncated: matches.length > CANDIDATE_LIMIT });
}

async function decide(
  partnerId: string, provider: AccountingProviderId, input: Record<string, unknown>, auth: AuthContext,
  decision: Exclude<MappingDecision, 'create_new'>,
): Promise<string> {
  const entity = entityArgs(input);
  if (typeof entity === 'string') return entity;
  const remoteEntityId = typeof input.remoteEntityId === 'string' ? input.remoteEntityId : undefined;
  if (decision === 'confirmed' && !remoteEntityId) return jsonError('remoteEntityId is required to link a mapping', 'VALIDATION_ERROR');
  if (decision !== 'confirmed' && remoteEntityId) return jsonError('remoteEntityId is only valid for link_mapping', 'VALIDATION_ERROR');
  const mapping = await saveMappingDecision({
    partnerId, provider, breezeEntityType: entity.entityType, breezeEntityId: entity.entityId, decision, remoteEntityId,
  }, (fn) => withAuthDbAccessContext(auth, fn));
  // As PUT /mappings: a confirmed decision enqueues the sync (the stale-row sweep recovers a miss).
  let syncEnqueued: boolean | null = null;
  if (decision === 'confirmed') {
    syncEnqueued = await enqueueAccountingMappingSync(entity.entityType, entity.entityId, partnerId, mapping.integrationId);
  }
  auditToolWrite(auth, {
    orgId: entity.entityType === 'org' ? entity.entityId : null, partnerId,
    action: 'accounting.mapping.update', resourceType: 'accounting_mapping', resourceId: mapping.id,
    details: {
      provider, breezeEntityType: entity.entityType, breezeEntityId: entity.entityId, decision,
      remoteEntityType: mapping.remoteEntityType, resultStatus: mapping.syncStatus, tool_name: TOOL,
    },
  });
  return bounded({ mapping: mappingView(mapping), ...(syncEnqueued === null ? {} : { syncEnqueued }) });
}

async function syncOne(partnerId: string, provider: AccountingProviderId, input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  const entity = entityArgs(input);
  if (typeof entity === 'string') return entity;
  // PR B quorum QB5: a sync that would CREATE the remote record (a create_new row, or a row with no remote id) is
  // not offered: its job and the stale-row sweep reload live rows long after any approval. Only an UPDATE of a
  // record a person linked is.
  const [row] = await withAuthDbAccessContext(auth, () => db.select({
    linkStatus: accountingEntityMappings.linkStatus, remoteEntityId: accountingEntityMappings.remoteEntityId,
  }).from(accountingEntityMappings)
    .innerJoin(accountingConnections, and(
      eq(accountingConnections.id, accountingEntityMappings.integrationId),
      eq(accountingConnections.provider, provider),
    ))
    .where(and(
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.breezeEntityType, entity.entityType),
      eq(accountingEntityMappings.breezeEntityId, entity.entityId),
    ))
    .limit(1));
  if (!row || row.linkStatus !== 'confirmed' || !row.remoteEntityId) {
    return jsonError('Only a linked mapping can be synced here; creating the record in the provider is done in the web app', 'CREATE_NOT_SUPPORTED');
  }
  const mapping = await syncMappedEntity({
    partnerId, provider, breezeEntityType: entity.entityType, breezeEntityId: entity.entityId,
  }, (fn) => withAuthDbAccessContext(auth, fn));
  auditToolWrite(auth, {
    orgId: entity.entityType === 'org' ? entity.entityId : null, partnerId,
    action: 'accounting.entity.sync', resourceType: 'accounting_mapping', resourceId: mapping.id,
    details: {
      provider, breezeEntityType: entity.entityType, breezeEntityId: entity.entityId,
      remoteEntityType: mapping.remoteEntityType, resultStatus: mapping.syncStatus, tool_name: TOOL,
    },
  });
  return bounded({ mapping: mappingView(mapping) });
}

/** The invoices that are this partner's (REST: partner_id = the partner, under full-partner authority). */
async function ownedInvoiceIds(ids: readonly string[], partnerId: string, auth: AuthContext): Promise<Set<string>> {
  // Belt to the handler's top-level refusal: a restricted session owns no invoice here.
  if (!canMutateOrgWideGovernance(auth)) return new Set();
  const rows = await withAuthDbAccessContext(auth, () => db.select({ id: invoices.id })
    .from(invoices).where(and(inArray(invoices.id, [...ids]), eq(invoices.partnerId, partnerId))));
  return new Set(rows.map((r) => r.id));
}

async function pushOne(partnerId: string, provider: AccountingProviderId, invoiceId: string, auth: AuthContext) {
  const outcome = await pushInvoiceToAccounting(invoiceId, partnerId, (fn) => withAuthDbAccessContext(auth, fn), { provider });
  auditToolWrite(auth, {
    orgId: null, partnerId, action: 'accounting.invoice.push', resourceType: 'accounting_mapping', resourceId: outcome.mappingId,
    details: {
      provider, invoiceId, remoteEntityId: outcome.remoteEntityId, docNumber: outcome.docNumber, syncStatus: outcome.syncStatus,
      taxVarianceCents: outcome.taxVarianceCents, totalVarianceCents: outcome.totalVarianceCents, tool_name: TOOL,
    },
  });
  return {
    invoiceId, syncStatus: outcome.syncStatus, docNumber: outcome.docNumber,
    taxVarianceCents: outcome.taxVarianceCents, totalVarianceCents: outcome.totalVarianceCents,
  };
}

async function push(partnerId: string, provider: AccountingProviderId, input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  if (typeof input.invoiceId !== 'string') return jsonError('invoiceId is required', 'VALIDATION_ERROR');
  const invoiceId = input.invoiceId;
  if (!(await ownedInvoiceIds([invoiceId], partnerId, auth)).has(invoiceId)) return notFound('Invoice');
  return bounded(await pushOne(partnerId, provider, invoiceId, auth));
}

/**
 * PR B quorum QB5: pushed here, one by one, at release — never handed to the queue, whose job would reload the
 * invoice later, outside the approval the effect digest pinned. Capped at ACCOUNTING_PUSH_BULK_MAX (REST: 100).
 * One invoice's refusal does not stop the rest (each reports its own outcome), except a refusal that would repeat for
 * every later invoice (throttle, reauth, permission, not connected) or an unexpected failure: those stop the loop and
 * the rest are reported as not attempted.
 */
async function pushBulk(partnerId: string, provider: AccountingProviderId, input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  const ids = Array.isArray(input.invoiceIds) ? [...new Set(input.invoiceIds.filter((v): v is string => typeof v === 'string'))] : [];
  if (ids.length === 0 || ids.length > ACCOUNTING_PUSH_BULK_MAX) {
    return jsonError(`invoiceIds needs 1 to ${ACCOUNTING_PUSH_BULK_MAX} invoice ids`, 'VALIDATION_ERROR');
  }
  const owned = await ownedInvoiceIds(ids, partnerId, auth);
  const results: Array<Record<string, unknown>> = [];
  for (const invoiceId of ids) {
    if (!owned.has(invoiceId)) { results.push({ invoiceId, code: 'NOT_FOUND' }); continue; }
    try {
      results.push(await pushOne(partnerId, provider, invoiceId, auth));
    } catch (error) {
      const coded = serviceErrorBody(error);
      if (!coded) {
        // Review: an unexpected failure must not discard what already reached the books. Its own state is unknown,
        // so stop, say so, and report the rest as not attempted (the results and audit below always run).
        console.error(`[${TOOL}] push_bulk unexpected failure`, invoiceId, error);
        captureException(error instanceof Error ? error : new Error(String(error)));
        results.push({ invoiceId, code: 'INTERNAL_ERROR', error: 'Unexpected failure; check in the books whether this invoice arrived before retrying' });
        break;
      }
      results.push({ invoiceId, ...coded });
      if (STOPS_BULK.has(coded.code)) break;
    }
  }
  const pushed = results.filter((r) => typeof r.syncStatus === 'string').length;
  auditToolWrite(auth, {
    orgId: null, partnerId, action: 'accounting.invoice.push_bulk', resourceType: 'accounting_mapping',
    details: { provider, requested: ids.length, pushed, failed: results.length - pushed, notAttempted: ids.length - results.length, tool_name: TOOL },
  });
  return bounded({ requested: ids.length, pushed, results, notAttempted: ids.slice(results.length) });
}

export function registerAccountingSyncTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    deviceArgs: [],
    domain: 'billing',
    searchHint: 'QuickBooks / Xero accounting sync: connection status, customer and item mappings, push invoices to the books',
    // Every action but status / owed_operations / push_bulk calls the provider over HTTP (or waits on it): the handler
    // opens its own short contexts and must not run inside a held per-call transaction (#7128, as the routes'
    // SELF_MANAGED_DB_CONTEXT_ROUTES registrations).
    selfManagedDbContext: true,
    definition: {
      name: TOOL,
      description: 'QuickBooks or Xero sync for the partner. Actions: status, owed_operations, customers, mappings, income_accounts, remote_candidates, link_mapping, unlink_mapping, sync_mapping (approval), push, push_bulk (two approvers).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...ACCOUNTING_SYNC_ACTIONS], description: 'The action to perform' },
          provider: { type: 'string', enum: [...ACCOUNTING_PROVIDERS], description: 'The accounting provider' },
          entityType: { type: 'string', enum: ['org', 'catalog_item'], description: 'mappings / remote_candidates / mapping writes: customer (org) or item' },
          entityId: { type: 'string', description: 'Mapping writes: the org or catalog item UUID' },
          remoteEntityId: { type: 'string', description: 'link_mapping: the provider customer / item id (from remote_candidates)' },
          q: { type: 'string', description: 'remote_candidates: name or SKU filter, applied in Breeze' },
          invoiceId: { type: 'string', description: 'push: invoice UUID' },
          invoiceIds: { type: 'array', items: { type: 'string' }, description: `push_bulk: up to ${ACCOUNTING_PUSH_BULK_MAX} invoice UUIDs` },
        },
        required: ['action', 'provider'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!ACCOUNTING_SYNC_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const provider = input.provider as AccountingProviderId;
      if (!ACCOUNTING_PROVIDERS.includes(provider)) return jsonError('provider must be quickbooks or xero', 'VALIDATION_ERROR');
      const partner = partnerOrRefusal(auth);
      if ('refusal' in partner) return partner.refusal;
      // The realm is partner-wide (every org's customers and invoices): a site- or device-restricted session never
      // reaches it (REST's full-partner authority implies the same for a partner member).
      if (!canMutateOrgWideGovernance(auth)) {
        return jsonError('Accounting sync covers every organization; a site- or device-restricted session cannot use it', 'ACCESS_DENIED');
      }
      const gate = providerRefusal(provider, action);
      if (gate) return gate;
      const mfa = mfaGatedToolError(TOOL, action, auth);
      if (mfa) return mfa;
      const runner = <T>(fn: () => Promise<T>) => withAuthDbAccessContext(auth, fn);
      const { partnerId } = partner;
      try {
        switch (action) {
          case 'status':
            return await status(partnerId, provider, auth);
          case 'owed_operations':
            return await owedOperations(partnerId, provider, auth);
          case 'customers': {
            const rows = await listAccountingCustomersAnnotated(partnerId, provider);
            return bounded({ customers: rows.map((r) => ({
              id: r.id, displayName: r.displayName, currencyCode: r.currencyCode ?? null,
              alreadyImported: r.alreadyImported, organizationId: r.organizationId,
            })) });
          }
          case 'mappings': {
            if (input.entityType !== 'org' && input.entityType !== 'catalog_item') return jsonError('entityType must be org or catalog_item', 'VALIDATION_ERROR');
            return bounded({ mappings: await listMappingProposals({ partnerId, provider, entityType: input.entityType }, runner) });
          }
          case 'income_accounts':
            return bounded({ accounts: await listRemoteIncomeAccountsForPartner({ partnerId, provider }, runner) });
          case 'remote_candidates':
            return await remoteCandidates(partnerId, provider, input, auth);
          case 'link_mapping':
            return await decide(partnerId, provider, input, auth, 'confirmed');
          case 'unlink_mapping':
            return await decide(partnerId, provider, input, auth, 'unlinked');
          case 'sync_mapping':
            return await syncOne(partnerId, provider, input, auth);
          case 'push':
            return await push(partnerId, provider, input, auth);
          case 'push_bulk':
            return await pushBulk(partnerId, provider, input, auth);
          default:
            return jsonError(`Unknown action: ${String(action)}`);
        }
      } catch (error) {
        return serviceError(error) ?? thrown(TOOL, error);
      }
    },
  });
}
