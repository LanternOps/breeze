export type MethodType = 'card' | 'us_bank_account';
export interface AutopayPageData {
  partnerName: string; logoUrl: string | null; primaryColor?: string | null; scheduleText: string;
  achMode: 'card_only' | 'ach_preferred' | 'ach_only';
  enrollment: { status: 'requested' | 'active' | 'paused' | 'cancelled'; effectiveFrom?: string | null } | null;
  method: { type: MethodType; cardBrand?: string | null; cardLast4?: string | null; cardFunding?: string | null;
    bankName?: string | null; bankLast4?: string | null; status: string } | null;
  disclosures: Record<MethodType, { text: string; hash: string; feeText: string }>;
}
export interface SetupOutcome { outcome: 'activated' | 'pending_verification' | 'stale_generation' | 'failed'; orgId: string; methodLabel: string | null; feeText: string }
export function savedMethodLabel(method: AutopayPageData['method']): string {
  if (!method) return 'No payment method on file';
  return method.type === 'card' ? `${method.cardBrand ?? 'Card'} ${method.cardFunding ?? ''} ••${method.cardLast4 ?? '????'}`
    : `${method.bankName ?? 'Bank account'} ••${method.bankLast4 ?? '????'}`;
}
