import type { useTranslation } from 'react-i18next';
import type { TicketConfig } from '../../lib/ticketConfigApi';
import type { TicketPriority, TicketStatus } from './ticketConfig';

export type TFunction = ReturnType<typeof useTranslation>['t'];

/** Mirrors the API's BlockedCurrencySummary (invoiceService.ts, #3776). */
export interface BlockedCurrencyGroup { currencyCode: string; count: number; amount: string }
/** Mirrors MissingRateEntry (invoiceService.ts, #3776 review #1): a billable time
 *  entry with no hourly rate. Never billed at zero — set a rate and assemble again. */
export interface MissingRateEntry { timeEntryId: string; ticketId: string | null; description: string; hours: string }
/** POST /tickets/:id/invoice success body. `blockedByCurrency` / `missingRate`
 *  are non-empty on a PARTIAL success: the draft exists but those rows were
 *  left out of it (review #3). */
export interface AssembleInvoiceResponse {
  data: { invoice: { id: string }; blockedByCurrency?: BlockedCurrencyGroup[]; missingRate?: MissingRateEntry[]; heldForHourBlock?: { count: number; hours: number } };
}
/** Mirrors MoveCurrencyGuardDetails (ticketMoveCurrencyGuard.ts, #3776). */
export interface MoveBlockedDetails {
  sourceCurrency: string;
  targetCurrency: string;
  unbilledTimeEntries: number;
  unbilledParts: number;
  /** Real per-snapshot groups (rows whose currency ≠ target); optional for older API builds. */
  blockedByCurrency?: Array<{ currencyCode: string; timeEntries: number; parts: number }>;
}

export type TicketTriageSuggestion = {
  modelVersion: string;
  confidence: number;
  priority: TicketPriority | null;
  categoryId: string | null;
  categoryName: string | null;
  reasons: string[];
};

// P2-4 (#4191), Task 11 — mirrors ActiveTicketDraftRow (ticketService.ts).
export type TicketAiDraft = {
  id: string;
  kind: 'reply' | 'resolution_note';
  content: string;
  createdAt: string;
  runId: string | null;
};

export type UserOption = { id: string; name: string | null; email: string };
export type OrgOption = { id: string; name: string; currencyCode?: string };

export const STATUS_OPTIONS: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'];
export const PRIORITY_OPTIONS: TicketPriority[] = ['urgent', 'high', 'normal', 'low'];

export function translatedPriorityLabel(config: TicketConfig | null, priority: TicketPriority, t: TFunction): string {
  return config?.priorities[priority]?.label ?? t(/* i18n-dynamic */ `tickets:ticketWorkbench.priority.${priority}`);
}
