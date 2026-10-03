import type { AutopayOffsetRule, AutopayPaymentMethodType, AccountHolderType } from '@breeze/shared';

export function utcDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid UTC date');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid UTC date');
  }
  return date;
}
export function addUtcDays(value: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error('Days must be an integer');
  const date = utcDay(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function computeCollectOn(input: {
  issueDate: string; dueDate: string; offsetDays: number;
  rule: AutopayOffsetRule; noticeDate: string; leadDays: number;
}): string {
  if (!Number.isInteger(input.offsetDays) || input.offsetDays < 0 || input.offsetDays > 60) {
    throw new Error('Invalid autopay offset');
  }
  if (input.leadDays !== 1 && input.leadDays !== 10) throw new Error('Invalid notice lead');
  utcDay(input.dueDate);
  const offsetDate = addUtcDays(input.issueDate, input.offsetDays);
  const chosen = input.rule === 'earlier'
    ? (offsetDate < input.dueDate ? offsetDate : input.dueDate)
    : (offsetDate > input.dueDate ? offsetDate : input.dueDate);
  const earliest = addUtcDays(input.noticeDate, input.leadDays);
  return chosen > earliest ? chosen : earliest;
}
export function noticeLeadDays(method: {
  type: AutopayPaymentMethodType; accountHolderType: AccountHolderType | null;
}): 1 | 10 {
  return method.type === 'us_bank_account' && method.accountHolderType === 'individual' ? 10 : 1;
}
