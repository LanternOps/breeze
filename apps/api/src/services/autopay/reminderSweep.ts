const DAY_MS = 86_400_000;

function utcDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Expected YYYY-MM-DD');
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new RangeError('Invalid calendar date');
  }
  return ms / DAY_MS;
}

export function reminderDueToday(input: {
  dueDate: string; today: string; beforeDueDays: number; repeatDays: number | null;
  overdueEveryDays: number; lastSentSeq: number;
}): { kind: 'payment_reminder' | 'payment_overdue'; seq: number } | null {
  for (const interval of [input.beforeDueDays, input.repeatDays, input.overdueEveryDays]) {
    if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 31)) {
      throw new RangeError('Reminder intervals must be integers in 1–31');
    }
  }
  if (!Number.isSafeInteger(input.lastSentSeq) || input.lastSentSeq < 0) {
    throw new RangeError('Invalid lastSentSeq');
  }
  const delta = utcDay(input.today) - utcDay(input.dueDate);
  let kind: 'payment_reminder' | 'payment_overdue';
  let seq: number;
  if (delta < 0) {
    const elapsed = delta + input.beforeDueDays;
    if (elapsed < 0) return null;
    if (elapsed === 0) seq = 1;
    else {
      if (input.repeatDays === null || elapsed % input.repeatDays !== 0) return null;
      seq = 1 + elapsed / input.repeatDays;
    }
    kind = 'payment_reminder';
  } else {
    if (delta === 0 || delta % input.overdueEveryDays !== 0) return null;
    kind = 'payment_overdue';
    seq = delta / input.overdueEveryDays;
  }
  return seq > input.lastSentSeq ? { kind, seq } : null;
}
