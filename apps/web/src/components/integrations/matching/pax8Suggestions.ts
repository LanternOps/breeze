import type { MatchReviewBlockedItem, MatchReviewItem } from "./SuggestedMatchReviewModal";

// Mirrors Pax8CompanySuggestion from apps/api/src/services/pax8CompanyMapping.ts.
export type Pax8CompanySuggestion =
  | { status: "match"; orgId: string; orgName: string; tier: "exact" | "normalized"; matchKey: string }
  | {
      status: "ambiguous";
      candidates: Array<{ orgId: string; orgName: string }>;
      tier: "exact" | "normalized";
      matchKey: string;
    }
  | {
      status: "contested";
      orgId: string;
      orgName: string;
      tier: "exact" | "normalized";
      matchKey: string;
      contestedWith: Array<{ pax8CompanyId: string; pax8CompanyName: string | null }>;
    };

export interface Pax8MappingSummary {
  unmapped: number;
  suggested: number;
  newUnmapped: number;
}

interface SuggestibleCompany {
  pax8CompanyId: string;
  pax8CompanyName: string | null;
  suggestion?: Pax8CompanySuggestion | null;
}

/** Split companies into reviewable `match` rows and rows that need a manual pick. */
export function buildReviewLists(companies: SuggestibleCompany[]): {
  items: MatchReviewItem[];
  blocked: MatchReviewBlockedItem[];
} {
  const items: MatchReviewItem[] = [];
  const blocked: MatchReviewBlockedItem[] = [];
  for (const c of companies) {
    const s = c.suggestion;
    if (!s) continue;
    const externalName = c.pax8CompanyName ?? c.pax8CompanyId;
    if (s.status === "match") {
      items.push({
        key: c.pax8CompanyId,
        externalName,
        targetLabel: s.orgName,
        tier: s.tier,
        matchKey: s.matchKey,
      });
    } else {
      blocked.push({ key: c.pax8CompanyId, externalName, reason: s.status });
    }
  }
  return { items, blocked };
}
