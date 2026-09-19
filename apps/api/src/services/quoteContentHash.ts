import { createHash } from 'node:crypto';

type HashableQuote = {
  id: string; currencyCode: string;
  subtotal: string; taxTotal: string; total: string;
  oneTimeTotal: string; monthlyRecurringTotal: string; annualRecurringTotal: string;
  depositType?: string | null; depositPercent?: string | null; depositAmount?: string | null;
};
type HashableBlock = { id: string; blockType: string; content: unknown; sortOrder: number };
type HashableLine = {
  id: string; description: string; quantity: string; unitPrice: string; lineTotal: string;
  recurrence: string; taxable: boolean; customerVisible: boolean; sortOrder: number;
  depositEligible?: boolean;
  contractLineType?: string | null;
  deviceRoles?: string[] | null;
  deviceGroupName?: string | null;
  siteName?: string | null;
  includedQuantity?: string | null;
  overageMode?: string | null;
  overageUnitPrice?: string | null;
};
export type QuoteHashVersion = 1 | 2;
/**
 * A quote's contract block content at the point it's about to be signed:
 * which (immutable) template version rendered, and the fully-resolved
 * variable set (auto + manual) that filled it in. Folding this into the
 * acceptance hash means a later edit to a manual variable — or a template
 * republish that would repoint templateVersionSha256 — invalidates a prior
 * acceptance's signature, same as a tampered line amount does today.
 */
export type HashableContractPart = {
  blockId: string;
  templateVersionSha256: string;
  resolvedVariables: Record<string, string>;
};

/**
 * Canonical, order-independent serialization of a quote's billable CONTENT,
 * hashed with SHA-256. Captured at accept time and stored on
 * quote_acceptances.quote_sha256 so a later edit (or a forged re-render) can be
 * detected. Sorting by (sortOrder, id) makes the hash independent of the array
 * order the caller happens to pass while staying sensitive to any value change.
 *
 * Deliberately EXCLUDES volatile workflow fields (status, quote number): the
 * quote legitimately transitions sent→converted during accept, so folding
 * `status` in would make a future re-verification of the now-'converted' quote
 * false-positive on tampering (C4). Only content that must stay immutable for
 * the signature to mean anything (money, lines, blocks, currency) is hashed.
 */
export function computeQuoteSha256(
  quote: HashableQuote,
  blocks: HashableBlock[],
  lines: HashableLine[],
  contractParts: HashableContractPart[],
  /** Which canonicalisation to use. v1 is byte-for-byte the pre-#3205-W05
   *  function — no `version` key, no `deviceSet`, whatever the rows carry — so
   *  every acceptance recorded before that release re-verifies identically
   *  forever. The version is READ FROM quote_acceptances.hash_version, never
   *  inferred from the data being verified. */
  version: QuoteHashVersion = 2,
): string {
  const canonical: { quote: Record<string, unknown>; blocks: unknown[]; lines: unknown[]; contracts?: unknown[] } = {
    quote: {
      ...(version === 2 ? { version: 2 } : {}),
      id: quote.id, currency: quote.currencyCode,
      subtotal: quote.subtotal, taxTotal: quote.taxTotal, total: quote.total,
      oneTime: quote.oneTimeTotal, monthly: quote.monthlyRecurringTotal, annual: quote.annualRecurringTotal,
    },
    blocks: [...blocks]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((b) => ({ id: b.id, type: b.blockType, sortOrder: b.sortOrder, content: b.content })),
    lines: [...lines]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((l) => ({
        id: l.id, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        lineTotal: l.lineTotal, recurrence: l.recurrence, taxable: l.taxable,
        customerVisible: l.customerVisible, sortOrder: l.sortOrder,
        ...(l.depositEligible ? { depositEligible: true } : {}),
        // The device set is part of what the customer signs. Emitted ONLY under
        // v2 and ONLY when the line HAS one, so a v2 quote with no descriptor
        // line still differs from its v1 hash by the `version` key alone — which
        // is the point: the format is declared, not guessed.
        //
        // STAMPED VALUES ONLY, never device_group_id / site_id: both are
        // ON DELETE SET NULL, and quoteAcceptanceVerify recomputes this hash
        // from current rows, so hashing an id would report a legitimate group
        // or site deletion as tampering on an already-accepted quote.
        // roles are sorted so insertion order cannot move the hash.
        ...(version === 2 && l.contractLineType ? { deviceSet: {
          type: l.contractLineType,
          roles: l.deviceRoles ? [...l.deviceRoles].sort() : null,
          groupName: l.deviceGroupName ?? null,
          siteName: l.siteName ?? null,
          included: l.includedQuantity ?? null,
          overageMode: l.overageMode ?? null,
          overageUnitPrice: l.overageUnitPrice ?? null,
        } } : {}),
      })),
  };
  // Deposit terms are part of what the customer signs. Included ONLY when a
  // deposit is configured so every pre-deposit acceptance hash stays verifiable.
  if (quote.depositType && quote.depositType !== 'none') {
    canonical.quote.deposit = {
      type: quote.depositType,
      percent: quote.depositPercent ?? null,
      amount: quote.depositAmount ?? null,
    };
  }
  // Contract block content is part of what the customer signs once the quote
  // embeds one. Included ONLY when non-empty so every pre-contract acceptance
  // hash stays verifiable — same pattern as the deposit block above.
  if (contractParts.length > 0) {
    canonical.contracts = [...contractParts]
      .sort((a, b) => a.blockId.localeCompare(b.blockId))
      .map((p) => ({
        blockId: p.blockId,
        versionSha: p.templateVersionSha256,
        vars: Object.fromEntries(Object.entries(p.resolvedVariables).sort(([a], [b]) => a.localeCompare(b))),
      }));
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
