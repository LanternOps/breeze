import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  contracts,
  contractLines,
  pax8CompanyMappings,
  pax8Integrations,
  pax8OrderLines,
  pax8Orders,
  pax8ProductMappings,
} from '../db/schema';
import { buildDedupeKey } from './pax8OrderService';
import { QuoteServiceError } from './quoteTypes';

export const PAX8_COMPANY_MAPPING_REQUIRED_ERROR =
  'Organization is not mapped to a Pax8 company — map it before submitting.';

type QuoteLineRecurrence = 'monthly' | 'annual' | 'one_time';

export interface StagePax8OrderInput {
  quoteId: string;
  orgId: string;
  partnerId: string;
  contractIds: string[];
  contractLineLinks: Array<{ quoteLineId: string; contractLineId: string }>;
  lines: Array<{
    id: string;
    catalogItemId: string | null;
    quantity: string;
    recurrence: QuoteLineRecurrence;
    customerVisible: boolean;
  }>;
  actorUserId: string | null;
}

interface ActiveProductMapping {
  integrationId: string;
  catalogItemId: string;
  pax8ProductId: string;
}

interface CompanyMapping {
  pax8CompanyId: string;
}

interface CreatedContractLine {
  id: string;
}

type OrderInsert = typeof pax8Orders.$inferInsert;
type OrderLineInsert = typeof pax8OrderLines.$inferInsert;

export interface QuoteToPax8OrderRepository {
  findActiveProductMappings(partnerId: string, catalogItemIds: string[]): Promise<ActiveProductMapping[]>;
  findCompanyMappings(partnerId: string, orgId: string, integrationId: string): Promise<CompanyMapping[]>;
  findCreatedContractLines(
    partnerId: string,
    orgId: string,
    contractIds: string[],
    contractLineIds: string[],
  ): Promise<CreatedContractLine[]>;
  insertOrder(value: OrderInsert): Promise<void>;
  insertOrderLines(values: OrderLineInsert[]): Promise<void>;
}

export const quoteToPax8OrderRepository: QuoteToPax8OrderRepository = {
  async findActiveProductMappings(partnerId, catalogItemIds) {
    if (catalogItemIds.length === 0) return [];
    return db
      .select({
        integrationId: pax8ProductMappings.integrationId,
        catalogItemId: pax8ProductMappings.catalogItemId,
        pax8ProductId: pax8ProductMappings.pax8ProductId,
      })
      .from(pax8ProductMappings)
      .innerJoin(pax8Integrations, and(
        eq(pax8Integrations.id, pax8ProductMappings.integrationId),
        eq(pax8Integrations.partnerId, pax8ProductMappings.partnerId),
        eq(pax8Integrations.isActive, true),
      ))
      .where(and(
        eq(pax8ProductMappings.partnerId, partnerId),
        inArray(pax8ProductMappings.catalogItemId, catalogItemIds),
      )) as Promise<ActiveProductMapping[]>;
  },

  async findCompanyMappings(partnerId, orgId, integrationId) {
    return db
      .select({ pax8CompanyId: pax8CompanyMappings.pax8CompanyId })
      .from(pax8CompanyMappings)
      .innerJoin(pax8Integrations, and(
        eq(pax8Integrations.id, pax8CompanyMappings.integrationId),
        eq(pax8Integrations.partnerId, pax8CompanyMappings.partnerId),
        eq(pax8Integrations.isActive, true),
      ))
      .where(and(
        eq(pax8CompanyMappings.partnerId, partnerId),
        eq(pax8CompanyMappings.integrationId, integrationId),
        eq(pax8CompanyMappings.orgId, orgId),
        eq(pax8CompanyMappings.ignored, false),
      ));
  },

  async findCreatedContractLines(partnerId, orgId, contractIds, contractLineIds) {
    if (contractIds.length === 0 || contractLineIds.length === 0) return [];
    return db
      .select({ id: contractLines.id })
      .from(contractLines)
      .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
      .where(and(
        inArray(contracts.id, contractIds),
        inArray(contractLines.id, contractLineIds),
        eq(contracts.partnerId, partnerId),
        eq(contracts.orgId, orgId),
        eq(contractLines.orgId, orgId),
        eq(contractLines.lineType, 'manual'),
      ))
      .orderBy(asc(contracts.id), asc(contractLines.sortOrder), asc(contractLines.id));
  },

  async insertOrder(value) {
    await db.insert(pax8Orders).values(value);
  },

  async insertOrderLines(values) {
    if (values.length > 0) await db.insert(pax8OrderLines).values(values);
  },
};

function billingTermFor(recurrence: QuoteLineRecurrence): 'Monthly' | 'Annual' | 'One-Time' {
  if (recurrence === 'monthly') return 'Monthly';
  if (recurrence === 'annual') return 'Annual';
  return 'One-Time';
}

interface QuoteToPax8OrderDependencies {
  repository: QuoteToPax8OrderRepository;
  randomUUID: () => string;
}

export function createQuoteToPax8OrderService(deps: QuoteToPax8OrderDependencies) {
  return async function stage(input: StagePax8OrderInput): Promise<{ orderId: string | null; lineCount: number }> {
    const candidateLines = input.lines.filter(
      (line) => line.customerVisible && line.catalogItemId !== null,
    );
    if (candidateLines.length === 0) return { orderId: null, lineCount: 0 };

    const catalogItemIds = [...new Set(candidateLines.map((line) => line.catalogItemId!))];
    const mappings = await deps.repository.findActiveProductMappings(input.partnerId, catalogItemIds);

    const mappingByCatalogItem = new Map<string, ActiveProductMapping>();
    const integrationIds = new Set<string>();
    for (const mapping of mappings) {
      integrationIds.add(mapping.integrationId);
      if (mappingByCatalogItem.has(mapping.catalogItemId)) {
        throw new QuoteServiceError(
          'Pax8 product mapping is ambiguous for an accepted quote line.',
          409,
          'INVALID_STATE',
        );
      }
      mappingByCatalogItem.set(mapping.catalogItemId, mapping);
    }
    if (integrationIds.size > 1) {
      throw new QuoteServiceError(
        'Accepted quote lines resolve to more than one active Pax8 integration.',
        409,
        'INVALID_STATE',
      );
    }

    const backedLines = candidateLines.flatMap((line) => {
      const mapping = mappingByCatalogItem.get(line.catalogItemId!);
      return mapping ? [{ line, mapping }] : [];
    });
    if (backedLines.length === 0) return { orderId: null, lineCount: 0 };

    const integrationId = backedLines[0]!.mapping.integrationId;
    const companyMappings = await deps.repository.findCompanyMappings(
      input.partnerId,
      input.orgId,
      integrationId,
    );
    const companyMapping = companyMappings.length === 1 ? companyMappings[0]! : null;

    const recurringBackedLines = backedLines.filter(({ line }) => line.recurrence !== 'one_time');
    const requestedContractLineIds = input.contractLineLinks.map((link) => link.contractLineId);
    const createdContractLines = recurringBackedLines.length > 0
      ? await deps.repository.findCreatedContractLines(
          input.partnerId,
          input.orgId,
          input.contractIds,
          requestedContractLineIds,
        )
      : [];
    const verifiedContractLineIds = new Set(createdContractLines.map((line) => line.id));
    const contractLineByQuoteLine = new Map<string, string>();
    const claimedContractLineIds = new Set<string>();
    for (const link of input.contractLineLinks) {
      if (contractLineByQuoteLine.has(link.quoteLineId) || claimedContractLineIds.has(link.contractLineId)) {
        throw new QuoteServiceError(
          'Phase 4 produced an ambiguous contract-line correlation for a quote line.',
          409,
          'INVALID_STATE',
        );
      }
      if (!verifiedContractLineIds.has(link.contractLineId)) continue;
      contractLineByQuoteLine.set(link.quoteLineId, link.contractLineId);
      claimedContractLineIds.add(link.contractLineId);
    }

    const orderId = deps.randomUUID();

    // Every recurring backed line must have an exact, verified Phase-4 source
    // correlation. This avoids both live catalog linkage and positional joins
    // against pre-existing/foreign contract rows.
    for (const { line } of recurringBackedLines) {
      if (!contractLineByQuoteLine.has(line.id)) {
        throw new QuoteServiceError(
          'A Pax8-backed recurring quote line did not match its newly created contract line.',
          409,
          'INVALID_STATE',
        );
      }
    }

    await deps.repository.insertOrder({
      id: orderId,
      integrationId,
      partnerId: input.partnerId,
      orgId: input.orgId,
      pax8CompanyId: companyMapping?.pax8CompanyId ?? null,
      status: 'awaiting_details',
      source: 'quote',
      sourceQuoteId: input.quoteId,
      dedupeKey: buildDedupeKey(orderId),
      error: companyMapping ? null : PAX8_COMPANY_MAPPING_REQUIRED_ERROR,
      createdBy: input.actorUserId,
    });

    const orderLines: OrderLineInsert[] = backedLines.map(({ line, mapping }, sortOrder) => {
      const contractLine = line.recurrence === 'one_time'
        ? null
        : contractLineByQuoteLine.get(line.id)!;
      return {
        orderId,
        partnerId: input.partnerId,
        orgId: input.orgId,
        action: 'new_subscription',
        pax8ProductId: mapping.pax8ProductId,
        catalogItemId: line.catalogItemId,
        billingTerm: billingTermFor(line.recurrence),
        quantity: line.quantity,
        provisioningDetails: [],
        contractLineId: contractLine,
        sourceQuoteLineId: line.id,
        sortOrder,
      };
    });
    await deps.repository.insertOrderLines(orderLines);

    return { orderId, lineCount: orderLines.length };
  };
}

export const stagePax8OrderFromQuote = createQuoteToPax8OrderService({
  repository: quoteToPax8OrderRepository,
  randomUUID,
});
