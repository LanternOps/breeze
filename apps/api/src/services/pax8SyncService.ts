import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  contractLines,
  organizations,
  pax8CompanyMappings,
  pax8ContractLineLinks,
  pax8Integrations,
  pax8ProductMappings,
  pax8SubscriptionSnapshots,
} from '../db/schema';
import { captureException } from './sentry';
import { decryptForColumn, encryptSecret } from './secretCrypto';
import { DEFAULT_PAX8_API_BASE_URL, DEFAULT_PAX8_TOKEN_URL, Pax8Client, type Pax8CompanyRecord, type Pax8SubscriptionRecord } from './pax8Client';

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function truncate(value: string | null, length: number): string | null {
  return value ? value.slice(0, length) : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Detect a Postgres unique-violation (23505) for a specific constraint. Drizzle
 * wraps the driver error, carrying the original `{ code, constraint_name }` on
 * `cause` (sometimes nested), so we walk the whole cause chain and also fall
 * back to matching the constraint name in any message.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  let candidate: unknown = err;
  for (let depth = 0; candidate && depth < 5; depth++) {
    if (typeof candidate === 'object') {
      const e = candidate as { code?: unknown; constraint_name?: unknown; message?: unknown; cause?: unknown };
      if (e.code === '23505' && (e.constraint_name === constraint || typeof e.constraint_name !== 'string')) {
        return true;
      }
      if (typeof e.message === 'string' && e.message.includes(constraint)) return true;
      candidate = e.cause;
    } else {
      break;
    }
  }
  return false;
}

export async function createPax8ClientForIntegration(integrationId: string, fetchImpl?: typeof fetch): Promise<{
  integration: typeof pax8Integrations.$inferSelect;
  client: Pax8Client;
}> {
  const [integration] = await db
    .select()
    .from(pax8Integrations)
    .where(eq(pax8Integrations.id, integrationId))
    .limit(1);
  if (!integration) throw new Error('Pax8 integration not found');
  if (!integration.isActive) throw new Error('Pax8 integration is inactive');

  const clientId = decryptForColumn('pax8_integrations', 'client_id_encrypted', integration.clientIdEncrypted);
  const clientSecret = decryptForColumn('pax8_integrations', 'client_secret_encrypted', integration.clientSecretEncrypted);
  if (!clientId || !clientSecret) throw new Error('Pax8 integration credentials could not be decrypted');

  const client = new Pax8Client({
    apiBaseUrl: integration.apiBaseUrl || DEFAULT_PAX8_API_BASE_URL,
    tokenUrl: integration.tokenUrl || DEFAULT_PAX8_TOKEN_URL,
    credentials: {
      clientId,
      clientSecret,
      accessToken: decryptForColumn('pax8_integrations', 'access_token_encrypted', integration.accessTokenEncrypted),
      accessTokenExpiresAt: integration.accessTokenExpiresAt,
    },
    fetch: fetchImpl,
  });
  return { integration, client };
}

async function persistTokenCache(integrationId: string, client: Pax8Client): Promise<void> {
  const cached = client.cachedAccessToken;
  if (!cached.token) return;
  await db.update(pax8Integrations).set({
    accessTokenEncrypted: encryptSecret(cached.token),
    accessTokenExpiresAt: cached.expiresAt,
    updatedAt: new Date(),
  }).where(eq(pax8Integrations.id, integrationId));
}

async function upsertCompanies(integrationId: string, partnerId: string, companies: Pax8CompanyRecord[]): Promise<number> {
  if (companies.length === 0) return 0;
  const now = new Date();
  const values = companies.map((company) => ({
    integrationId,
    partnerId,
    pax8CompanyId: company.pax8CompanyId.slice(0, 64),
    pax8CompanyName: company.name.slice(0, 255),
    status: truncate(company.status, 40),
    metadata: company.metadata,
    lastSeenAt: now,
    updatedAt: now,
  }));

  for (const batch of chunk(values, 500)) {
    await db.insert(pax8CompanyMappings).values(batch).onConflictDoUpdate({
      target: [pax8CompanyMappings.integrationId, pax8CompanyMappings.pax8CompanyId],
      set: {
        partnerId: sql`excluded.partner_id`,
        pax8CompanyName: sql`excluded.pax8_company_name`,
        status: sql`excluded.status`,
        metadata: sql`excluded.metadata`,
        lastSeenAt: sql`excluded.last_seen_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  }
  return values.length;
}

async function loadMappedCompanies(integrationId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ pax8CompanyId: pax8CompanyMappings.pax8CompanyId, orgId: pax8CompanyMappings.orgId })
    .from(pax8CompanyMappings)
    .where(and(eq(pax8CompanyMappings.integrationId, integrationId), eq(pax8CompanyMappings.ignored, false)));
  const result = new Map<string, string>();
  for (const row of rows) {
    if (row.orgId) result.set(row.pax8CompanyId, row.orgId);
  }
  return result;
}

async function upsertSubscriptions(params: {
  integrationId: string;
  partnerId: string;
  subscriptions: Pax8SubscriptionRecord[];
  mappedCompanies: Map<string, string>;
}): Promise<number> {
  if (params.subscriptions.length === 0) return 0;
  const now = new Date();
  const values = params.subscriptions.map((sub) => ({
    integrationId: params.integrationId,
    partnerId: params.partnerId,
    pax8CompanyId: sub.pax8CompanyId.slice(0, 64),
    orgId: params.mappedCompanies.get(sub.pax8CompanyId) ?? null,
    pax8SubscriptionId: sub.pax8SubscriptionId.slice(0, 64),
    productId: truncate(sub.productId, 64),
    productName: truncate(sub.productName, 255),
    vendorName: truncate(sub.vendorName, 255),
    vendorSkuId: truncate(sub.vendorSkuId, 120),
    status: truncate(sub.status, 40),
    billingTerm: truncate(sub.billingTerm, 40),
    quantity: sub.quantity,
    unitPrice: sub.unitPrice,
    unitCost: sub.unitCost,
    currencyCode: sub.currencyCode?.slice(0, 3).toUpperCase() ?? null,
    startDate: sub.startDate,
    endDate: sub.endDate,
    billingStart: sub.billingStart,
    commitmentTermEndDate: sub.commitmentTermEndDate,
    raw: sub.raw,
    lastSeenAt: now,
    updatedAt: now,
  }));

  for (const batch of chunk(values, 500)) {
    await db.insert(pax8SubscriptionSnapshots).values(batch).onConflictDoUpdate({
      target: [pax8SubscriptionSnapshots.integrationId, pax8SubscriptionSnapshots.pax8SubscriptionId],
      set: {
        partnerId: sql`excluded.partner_id`,
        pax8CompanyId: sql`excluded.pax8_company_id`,
        orgId: sql`excluded.org_id`,
        productId: sql`excluded.product_id`,
        productName: sql`excluded.product_name`,
        vendorName: sql`excluded.vendor_name`,
        vendorSkuId: sql`excluded.vendor_sku_id`,
        status: sql`excluded.status`,
        billingTerm: sql`excluded.billing_term`,
        quantity: sql`excluded.quantity`,
        unitPrice: sql`excluded.unit_price`,
        unitCost: sql`excluded.unit_cost`,
        currencyCode: sql`excluded.currency_code`,
        startDate: sql`excluded.start_date`,
        endDate: sql`excluded.end_date`,
        billingStart: sql`excluded.billing_start`,
        commitmentTermEndDate: sql`excluded.commitment_term_end_date`,
        raw: sql`excluded.raw`,
        lastSeenAt: sql`excluded.last_seen_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  }
  return values.length;
}

async function upsertProductMappings(integrationId: string, partnerId: string, subscriptions: Pax8SubscriptionRecord[]): Promise<number> {
  const byProduct = new Map<string, Pax8SubscriptionRecord>();
  for (const sub of subscriptions) {
    if (sub.productId && !byProduct.has(sub.productId)) byProduct.set(sub.productId, sub);
  }
  if (byProduct.size === 0) return 0;
  const now = new Date();
  const values = Array.from(byProduct.values()).map((sub) => ({
    integrationId,
    partnerId,
    pax8ProductId: sub.productId!.slice(0, 64),
    vendorSkuId: truncate(sub.vendorSkuId, 120),
    productName: truncate(sub.productName, 255),
    metadata: {
      vendorName: sub.vendorName,
      firstSeenFromSubscriptionId: sub.pax8SubscriptionId,
    },
    updatedAt: now,
  }));
  for (const batch of chunk(values, 500)) {
    await db.insert(pax8ProductMappings).values(batch).onConflictDoUpdate({
      target: [pax8ProductMappings.integrationId, pax8ProductMappings.pax8ProductId],
      set: {
        partnerId: sql`excluded.partner_id`,
        vendorSkuId: sql`excluded.vendor_sku_id`,
        productName: sql`excluded.product_name`,
        metadata: sql`excluded.metadata`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  }
  return values.length;
}

export async function applyEnabledPax8ContractLineLinks(integrationId: string): Promise<{ applied: number; skipped: number }> {
  const rows = await db
    .select({
      linkId: pax8ContractLineLinks.id,
      contractLineId: pax8ContractLineLinks.contractLineId,
      linkOrgId: pax8ContractLineLinks.orgId,
      quantity: pax8SubscriptionSnapshots.quantity,
      lineType: contractLines.lineType,
      lineOrgId: contractLines.orgId,
      subscriptionOrgId: pax8SubscriptionSnapshots.orgId,
    })
    .from(pax8ContractLineLinks)
    .innerJoin(pax8SubscriptionSnapshots, eq(pax8ContractLineLinks.subscriptionSnapshotId, pax8SubscriptionSnapshots.id))
    .innerJoin(contractLines, eq(pax8ContractLineLinks.contractLineId, contractLines.id))
    .where(and(eq(pax8ContractLineLinks.integrationId, integrationId), eq(pax8ContractLineLinks.syncEnabled, true)));

  let applied = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.lineType !== 'manual' || !row.subscriptionOrgId || row.subscriptionOrgId !== row.lineOrgId || row.linkOrgId !== row.lineOrgId) {
      skipped++;
      continue;
    }
    const now = new Date();
    await db.update(contractLines)
      .set({ manualQuantity: row.quantity })
      .where(and(eq(contractLines.id, row.contractLineId), eq(contractLines.lineType, 'manual' as never)));
    await db.update(pax8ContractLineLinks)
      .set({ lastAppliedQuantity: row.quantity, lastAppliedAt: now, updatedAt: now })
      .where(eq(pax8ContractLineLinks.id, row.linkId));
    applied++;
  }
  return { applied, skipped };
}

export interface Pax8SyncResult {
  integrationId: string;
  companies: number;
  subscriptions: number;
  products: number;
  appliedContractLines: number;
  skippedContractLines: number;
}

export async function syncPax8Integration(integrationId: string): Promise<Pax8SyncResult> {
  // Self-manages DB contexts so the Pax8 API fetch (Phase 2) holds no open
  // transaction — pinning a pooled connection across the ~20s HTTP window
  // starved the connection pool (#1697). Phases: mark-running → read+build
  // client → fetch (outside any context) → persist atomically.
  const startedAt = new Date();
  await withSystemDbAccessContext(() =>
    db.update(pax8Integrations).set({
      lastSyncStatus: 'running',
      lastSyncError: null,
      updatedAt: startedAt,
    }).where(eq(pax8Integrations.id, integrationId))
  );

  try {
    // Phase 1 — load the integration row and build the client (DB read only).
    const { integration, client } = await withSystemDbAccessContext(() =>
      createPax8ClientForIntegration(integrationId)
    );

    // Phase 2 — fetch from Pax8 with NO DB context held. The OAuth token
    // refresh also runs here, outside any transaction (#1105/#1697).
    const [companies, subscriptions] = await runOutsideDbContext(() =>
      Promise.all([
        client.listCompanies(),
        client.listSubscriptions(),
      ])
    );

    // Phase 3 — persist token cache + upserts + success status atomically.
    return await withSystemDbAccessContext(async () => {
      await persistTokenCache(integration.id, client);
      const companyCount = await upsertCompanies(integration.id, integration.partnerId, companies);
      const mappedCompanies = await loadMappedCompanies(integration.id);
      const subscriptionCount = await upsertSubscriptions({
        integrationId: integration.id,
        partnerId: integration.partnerId,
        subscriptions,
        mappedCompanies,
      });
      const productCount = await upsertProductMappings(integration.id, integration.partnerId, subscriptions);
      const applied = await applyEnabledPax8ContractLineLinks(integration.id);

      await db.update(pax8Integrations).set({
        lastSyncAt: new Date(),
        lastSyncStatus: 'success',
        lastSyncError: null,
        updatedAt: new Date(),
      }).where(eq(pax8Integrations.id, integration.id));

      return {
        integrationId: integration.id,
        companies: companyCount,
        subscriptions: subscriptionCount,
        products: productCount,
        appliedContractLines: applied.applied,
        skippedContractLines: applied.skipped,
      };
    });
  } catch (err) {
    // Record failure on a FRESH transaction so it survives Phase 3's rollback.
    // Guard the bookkeeping write itself: if it throws (e.g. pool exhaustion),
    // log + capture it but re-throw the ORIGINAL sync error, never the DB error.
    try {
      await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db.update(pax8Integrations).set({
            lastSyncAt: new Date(),
            lastSyncStatus: 'failed',
            lastSyncError: errorMessage(err).slice(0, 2000),
            updatedAt: new Date(),
          }).where(eq(pax8Integrations.id, integrationId))
        )
      );
    } catch (dbErr) {
      console.error(`[Pax8Sync] Failed to record sync error for integration ${integrationId}:`, dbErr);
      captureException(dbErr instanceof Error ? dbErr : new Error(String(dbErr)));
    }
    throw err;
  }
}

export async function mapPax8Company(input: {
  integrationId: string;
  partnerId: string;
  pax8CompanyId: string;
  orgId: string | null;
  ignored?: boolean;
}): Promise<{ pax8CompanyId: string; orgId: string | null; ignored: boolean }> {
  if (input.orgId) {
    const [org] = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, input.orgId))
      .limit(1);
    if (!org || org.partnerId !== input.partnerId) throw new Error('Target organization does not belong to this partner');
  }

  const [updated] = await db.update(pax8CompanyMappings).set({
    orgId: input.orgId,
    ignored: input.ignored ?? false,
    updatedAt: new Date(),
  }).where(and(
    eq(pax8CompanyMappings.integrationId, input.integrationId),
    eq(pax8CompanyMappings.partnerId, input.partnerId),
    eq(pax8CompanyMappings.pax8CompanyId, input.pax8CompanyId),
  )).returning({
    pax8CompanyId: pax8CompanyMappings.pax8CompanyId,
    orgId: pax8CompanyMappings.orgId,
    ignored: pax8CompanyMappings.ignored,
  });
  if (!updated) throw new Error('Pax8 company mapping not found. Run sync first to discover companies.');
  await db.update(pax8SubscriptionSnapshots).set({
    orgId: input.ignored ? null : input.orgId,
    updatedAt: new Date(),
  }).where(and(
    eq(pax8SubscriptionSnapshots.integrationId, input.integrationId),
    eq(pax8SubscriptionSnapshots.partnerId, input.partnerId),
    eq(pax8SubscriptionSnapshots.pax8CompanyId, input.pax8CompanyId),
  ));
  return updated;
}

export async function linkPax8SubscriptionToContractLine(input: {
  integrationId: string;
  partnerId: string;
  subscriptionSnapshotId: string;
  contractLineId: string;
  syncEnabled: boolean;
}): Promise<typeof pax8ContractLineLinks.$inferSelect> {
  const [snapshot] = await db
    .select({
      id: pax8SubscriptionSnapshots.id,
      orgId: pax8SubscriptionSnapshots.orgId,
      partnerId: pax8SubscriptionSnapshots.partnerId,
      integrationId: pax8SubscriptionSnapshots.integrationId,
    })
    .from(pax8SubscriptionSnapshots)
    .where(eq(pax8SubscriptionSnapshots.id, input.subscriptionSnapshotId))
    .limit(1);
  if (!snapshot || snapshot.partnerId !== input.partnerId || snapshot.integrationId !== input.integrationId) {
    throw new Error('Pax8 subscription not found');
  }
  if (!snapshot.orgId) throw new Error('Map the Pax8 company to a Breeze organization before linking billing lines.');

  const [line] = await db
    .select({ id: contractLines.id, orgId: contractLines.orgId, lineType: contractLines.lineType })
    .from(contractLines)
    .where(eq(contractLines.id, input.contractLineId))
    .limit(1);
  if (!line || line.orgId !== snapshot.orgId) throw new Error('Contract line does not belong to the mapped organization');
  if (line.lineType !== 'manual') throw new Error('Pax8 license sync requires a manual contract line');

  // Deterministic guard: a contract line can be linked to at most one
  // subscription (unique index on contract_line_id). Detect a conflicting link
  // up front so the caller gets a clear message instead of a raw constraint
  // error surfacing from inside the request transaction. The unique index below
  // remains the backstop for the race between this check and the insert.
  const [existingForLine] = await db
    .select({ subscriptionSnapshotId: pax8ContractLineLinks.subscriptionSnapshotId })
    .from(pax8ContractLineLinks)
    .where(eq(pax8ContractLineLinks.contractLineId, input.contractLineId))
    .limit(1);
  if (existingForLine && existingForLine.subscriptionSnapshotId !== input.subscriptionSnapshotId) {
    throw new Error('This contract line is already linked to another Pax8 subscription.');
  }

  // The upsert resolves a conflict on subscription_snapshot_id (re-linking the
  // same subscription). It does NOT cover the separate unique index on
  // contract_line_id, so linking a *different* subscription to an
  // already-linked contract line raises a raw 23505. Map it to a clear message
  // instead of surfacing the opaque Postgres constraint error to the caller.
  let link: typeof pax8ContractLineLinks.$inferSelect | undefined;
  try {
    [link] = await db.insert(pax8ContractLineLinks).values({
      integrationId: input.integrationId,
      partnerId: input.partnerId,
      orgId: snapshot.orgId,
      subscriptionSnapshotId: input.subscriptionSnapshotId,
      contractLineId: input.contractLineId,
      syncEnabled: input.syncEnabled,
    }).onConflictDoUpdate({
      target: pax8ContractLineLinks.subscriptionSnapshotId,
      set: {
        partnerId: sql`excluded.partner_id`,
        integrationId: sql`excluded.integration_id`,
        orgId: sql`excluded.org_id`,
        contractLineId: sql`excluded.contract_line_id`,
        syncEnabled: sql`excluded.sync_enabled`,
        updatedAt: sql`excluded.updated_at`,
      },
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err, 'pax8_contract_line_links_contract_line_uq')) {
      throw new Error('This contract line is already linked to another Pax8 subscription.');
    }
    throw err;
  }
  if (!link) throw new Error('Failed to link Pax8 subscription to contract line');
  return link;
}
