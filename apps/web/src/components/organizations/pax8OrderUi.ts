export interface PreflightErrors {
  byLine: Map<number, string[]>;
  order: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Pax8 varies detail keys; preserve readable raw messages and fail safely. */
export function extractPax8PreflightErrors(body: unknown): PreflightErrors {
  const result: PreflightErrors = { byLine: new Map(), order: [] };
  const root = record(body);
  const details = Array.isArray(root?.details) ? root.details : [];
  for (const raw of details) {
    const detail = record(raw);
    if (!detail) continue;
    const message = [detail.message, detail.detail, detail.error, detail.description]
      .find((candidate) => typeof candidate === 'string' && candidate.trim()) as string | undefined;
    if (!message) continue;
    const numberValue = detail.lineItemNumber ?? detail.line_item_number;
    const lineItemNumber = typeof numberValue === 'number'
      ? numberValue
      : typeof numberValue === 'string' && /^\d+$/.test(numberValue)
        ? Number(numberValue)
        : null;
    if (lineItemNumber === null) {
      result.order.push(message);
    } else {
      const messages = result.byLine.get(lineItemNumber) ?? [];
      messages.push(message);
      result.byLine.set(lineItemNumber, messages);
    }
  }
  if (details.length === 0 && typeof root?.error === 'string' && root.error.trim()) {
    result.order.push(root.error);
  }
  return result;
}

export function displayQuantity(value: string | null | undefined): string {
  if (value == null || value.trim() === '') return '—';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
