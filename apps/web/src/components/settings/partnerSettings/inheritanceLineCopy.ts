import type { TFunction } from 'i18next';
import type { InheritanceCounts, InheritanceFieldDto } from '@breeze/shared';
import type { InheritanceBucket } from '@/lib/api/partnerSettingsInheritance';

/**
 * The inline line under a partner setting (spec §5.4): what the org fleet
 * resolves to for this field, from SAVED configuration only. Pure: returns
 * clause keys and params, and the UI renders a clause with `drill` as the
 * button that opens the org list behind that count.
 *
 * Word meanings are fixed by the shared catalog (`COUNT_TERMS`): "has its own
 * value", "overrides", "shadowed", "in effect". A sealed field cannot be
 * compared for equality, so it never says "override" (`counts.overrides` is null).
 */
const K = 'partnerSettingsPage.inheritance.line';

export type LineClause = {
  key: string;
  params?: Record<string, string | number>;
  /** The bucket this clause's count opens in the drill-down. */
  drill?: InheritanceBucket;
};

export type LineCopy = {
  clauses: LineClause[];
  /** The field has an unsaved draft: the line describes the saved value. */
  savedPrefix: boolean;
};

export type LineOptions = {
  draftDirty: boolean;
  /** The platform default as display text, or null when it has none worth naming. */
  platformDefaultLabel: string | null;
  /** Consumer id → display label, for fields with `byConsumer`. */
  consumerLabels?: Record<string, string>;
};

/** Every key this module can emit (plural keys without their suffix), for the locale test. */
export const LINE_KEYS = [
  'appliesToAll', 'hadOwnValue', 'notSet', 'someSetOwn', 'restUsePlatformDefault', 'orgsUsePlatformDefault',
  'noneSetOwn', 'defaultFor', 'override', 'setOwn', 'clamped', 'notInForce', 'orgsUseOwnDestination', 'haveOne',
  'partnerOnlyDefault', 'partnerOnlyBlank', 'consumerAll', 'consumerOwn', 'noOrgs', 'savedValue', 'restricted',
].map(k => `${K}.${k}`);

const c = (key: string, params?: LineClause['params'], drill?: InheritanceBucket): LineClause =>
  ({ key: `${K}.${key}`, ...(params ? { params } : {}), ...(drill ? { drill } : {}) });

function lockedClauses(counts: InheritanceCounts | null, orgCount: number): LineClause[] {
  const out = [c('appliesToAll', { count: orgCount })];
  if (counts && counts.shadowed > 0) out.push(c('hadOwnValue', { count: counts.shadowed }, 'shadowed'));
  return out;
}

function blankLockClauses(counts: InheritanceCounts | null, orgCount: number, label: string | null): LineClause[] {
  const out = [c('notSet')];
  const own = counts?.ownValue ?? 0;
  if (own > 0) {
    out.push(c('someSetOwn', { count: own, total: orgCount }, 'ownValue'));
    if (label) out.push(c('restUsePlatformDefault', { value: label }));
  } else if (label) {
    out.push(c('orgsUsePlatformDefault', { value: label }));
  } else if (counts) {
    out.push(c('noneSetOwn'));
  }
  return out;
}

/**
 * Org values beside an overridable partner value. With no partner value there
 * is nothing to override, so an org value is "its own" (and a sealed value can
 * never be compared, so it is "its own" too).
 */
function overrideClauses(counts: InheritanceCounts | null, partnerSet: boolean): LineClause[] {
  if (!counts) return [];
  const out: LineClause[] = [];
  if (!partnerSet || counts.overrides === null) {
    if (counts.ownValue > 0) out.push(c('setOwn', { count: counts.ownValue }, 'ownValue'));
  } else if (counts.overrides > 0) {
    out.push(c('override', { count: counts.overrides }, 'overrides'));
  }
  if ((counts.clamped ?? 0) > 0) out.push(c('clamped', { count: counts.clamped! }, 'clamped'));
  return out;
}

export function inheritanceLineCopy(field: InheritanceFieldDto, orgCount: number, opts: LineOptions): LineCopy {
  const savedPrefix = opts.draftDirty;
  if (field.kind === 'unclassified') return { clauses: [], savedPrefix: false };
  if (orgCount === 0) return { clauses: [c('noOrgs')], savedPrefix };

  if (field.byConsumer && field.byConsumer.length > 0) {
    return {
      savedPrefix,
      clauses: field.byConsumer.map(({ consumerId, counts }) => {
        const consumer = opts.consumerLabels?.[consumerId] ?? consumerId;
        return counts.ownValue > 0
          ? c('consumerOwn', { consumer, count: counts.ownValue })
          : c('consumerAll', { consumer });
      }),
    };
  }

  const { counts } = field;
  const label = opts.platformDefaultLabel;
  let clauses: LineClause[];
  switch (field.kind) {
    case 'locks':
      if (field.qualifier === 'conditional' && field.partnerSet && !field.inForce) {
        clauses = [c('notInForce'), c('orgsUseOwnDestination')];
        if (counts && counts.ownValue > 0) clauses.push(c('haveOne', { count: counts.ownValue }, 'ownValue'));
      } else if (field.partnerSet) {
        clauses = lockedClauses(counts, orgCount);
      } else {
        clauses = blankLockClauses(counts, orgCount, label);
      }
      break;
    case 'overridable':
      if (field.partnerSet) {
        clauses = [c('defaultFor', { count: orgCount }), ...overrideClauses(counts, true)];
      } else {
        clauses = [c('notSet')];
        if (label) clauses.push(c('orgsUsePlatformDefault', { value: label }));
        const rest = overrideClauses(counts, false);
        if (!label && rest.length === 0 && counts) clauses.push(c('noneSetOwn'));
        clauses.push(...rest);
      }
      break;
    case 'partnerOnly':
      clauses = field.partnerSet
        ? [c('appliesToAll', { count: orgCount })]
        : [label ? c('partnerOnlyDefault', { value: label }) : c('partnerOnlyBlank')];
      break;
    default:
      clauses = [];
  }
  return { clauses, savedPrefix };
}

/** The line for a user without full partner org access: badges only, no counts. */
export const RESTRICTED_LINE: LineCopy = { clauses: [c('restricted')], savedPrefix: false };

/**
 * Clauses are joined with " · ", except after a clause that ends a sentence
 * (".") or introduces one (":"), which is followed by a plain space.
 */
export function joinerAfter(previous: string): string {
  return /[.:]$/.test(previous) ? ' ' : ' · ';
}

/** The line as plain text (tests, accessible summaries). */
export function lineText(copy: LineCopy, t: TFunction): string {
  const parts = copy.clauses.map(cl => t(/* i18n-dynamic */ cl.key, cl.params ?? {}) as string);
  if (copy.savedPrefix && parts.length > 0) parts.unshift(t(/* i18n-dynamic */ `${K}.savedValue`) as string);
  return parts.reduce((acc, part, i) => (i === 0 ? part : acc + joinerAfter(acc) + part), '');
}
