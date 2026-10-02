/**
 * Pure billing-rule resolution: no DB, no I/O. Shared by six callers: create,
 * timer start, edit, quick-add hint, org preview and aiTimeEntryProposal.
 *
 * fellBackToNoCard is a safety net only. The default-card guarantee means it
 * should never fire for a priced org entry in production; callers log at warn
 * when it does. Standalone entries have no org currency and remain unpriced.
 */
export type Coverage = 'billable' | 'included' | 'non_billable';

/** The loader filters inactive cards before passing them to the resolver. */
export interface ResolvedCard {
  id: string;
  currencyCode: string;
  roundingIncrementMinutes: number | null;
  baseCoverage: Coverage;
  baseHourlyRate: string | null;
  baseMinimumMinutes: number | null;
  rules: Array<{
    workTypeId: string;
    coverage: Coverage;
    hourlyRate: string | null;
    minimumMinutes: number | null;
  }>;
}

export interface BillingRule {
  billingProfileId: string | null;
  coverage: Coverage;
  hourlyRate: string | null;
  minimumMinutes: number | null;
  roundingIncrementMinutes: number | null;
  isBillable: boolean;
  billingStatus: 'not_billed' | 'contract';
  /** True when no card applied — the safety-net branch. Callers log at warn. */
  fellBackToNoCard: boolean;
}

/**
 * THE card resolver (#4628 §3.3; reused by AI chargeback #7608): the org's
 * assigned card if it is in the org's currency, else the partner default in
 * that currency, else none. Match-or-skip: a card in another currency is never
 * used and never converted. The loader filters inactive cards first.
 */
export function selectCard<C extends { currencyCode: string }>(input: {
  orgCurrency: string | null;
  assignedCard: C | null;
  partnerDefaultCard: C | null;
}): C | null {
  if (input.orgCurrency === null) return null;
  if (input.assignedCard?.currencyCode === input.orgCurrency) return input.assignedCard;
  if (input.partnerDefaultCard?.currencyCode === input.orgCurrency) return input.partnerDefaultCard;
  return null;
}

export function resolveBillingRule(input: {
  orgCurrency: string | null;
  assignedCard: ResolvedCard | null;
  partnerDefaultCard: ResolvedCard | null;
  workTypeId: string | null;
}): BillingRule {
  const card = selectCard(input);

  if (!card) {
    return {
      billingProfileId: null,
      coverage: 'billable',
      hourlyRate: null,
      minimumMinutes: null,
      roundingIncrementMinutes: null,
      isBillable: true,
      billingStatus: 'not_billed',
      fellBackToNoCard: true,
    };
  }

  // Choose a whole row: null rate/minimum values never inherit another row.
  const row = card.rules.find((rule) => rule.workTypeId === input.workTypeId) ?? {
    coverage: card.baseCoverage,
    hourlyRate: card.baseHourlyRate,
    minimumMinutes: card.baseMinimumMinutes,
  };
  return {
    billingProfileId: card.id,
    coverage: row.coverage,
    hourlyRate: row.coverage === 'billable' ? row.hourlyRate : null,
    minimumMinutes: row.coverage === 'billable' ? row.minimumMinutes : null,
    roundingIncrementMinutes: card.roundingIncrementMinutes,
    isBillable: row.coverage !== 'non_billable',
    billingStatus: row.coverage === 'included' ? 'contract' : 'not_billed',
    fellBackToNoCard: false,
  };
}
