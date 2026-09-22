/**
 * Group customer-visible invoice lines by ticket for display (#5856).
 *
 * Render-only: never reorders or mutates the stored lines' totals. Groups keep
 * first-seen order, lines keep their order within a group. Lines with no
 * ticket number share one headerless group. The customer DTO carries no
 * ticketId, so the ticket number is the grouping key here (the PDF and the
 * staff web view group by ticketId).
 */
export interface InvoiceLineGroup<T> {
  key: string;
  ticketNumber: string | null;
  ticketCategory: string | null;
  lines: T[];
}

export function groupInvoiceLinesByTicket<T extends { ticketNumber: string | null; ticketCategory?: string | null }>(
  lines: T[],
): InvoiceLineGroup<T>[] {
  const groups: InvoiceLineGroup<T>[] = [];
  const byKey = new Map<string, InvoiceLineGroup<T>>();
  for (const line of lines) {
    const key = line.ticketNumber ? `num_${line.ticketNumber}` : '__none__';
    let group = byKey.get(key);
    if (!group) {
      group = { key, ticketNumber: line.ticketNumber ?? null, ticketCategory: line.ticketCategory ?? null, lines: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.lines.push(line);
  }
  return groups;
}
