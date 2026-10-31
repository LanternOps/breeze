/**
 * Ticket summary and description for an alert → PSA ticket (#10499 W2-A, F4).
 *
 * Pure text builders. The W2-B worker calls them with the committed alert row
 * and the adapter's `alertTicketLimits`, then stores the result in the
 * mapping's `create_snapshot` before the POST.
 *
 * Lengths are in Unicode code points (`Array.from`), so a cut never splits a
 * surrogate pair. (A multi-code-point emoji sequence can still be cut between
 * its code points; that renders as two glyphs, never as invalid text.)
 */

const SEPARATOR = ' — ';
const ELLIPSIS = '…';

/** Ceiling on the alert message carried in the description, in code points. */
export const PSA_TICKET_DESCRIPTION_MAX_MESSAGE = 4000;

// C0/C1 controls except tab and newline, which `oneLine` folds anyway.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function oneLine(value: string): string {
  return value.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
}

function truncateCodePoints(value: string, max: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= max) return value;
  return codePoints.slice(0, Math.max(0, max - 1)).join('') + ELLIPSIS;
}

export interface TicketSummaryInput {
  severity: string;
  title: string;
  hostname: string | null;
}

export interface TicketSummaryLimits {
  maxCodePoints: number;
  /** Appended verbatim and never truncated (the adapter's summary marker, if any). */
  suffix?: string | null;
}

/** `[SEV] title — hostname`, cut to the PSA's limit. */
export function buildTicketSummary(input: TicketSummaryInput, limits: TicketSummaryLimits): string {
  const suffix = limits.suffix ?? '';
  const budget = limits.maxCodePoints - Array.from(suffix).length;
  if (budget < 2) {
    throw new Error(`Ticket summary limit ${limits.maxCodePoints} cannot hold the required marker`);
  }
  const hostname = input.hostname ? oneLine(input.hostname) : '';
  const text = `[${oneLine(input.severity).toUpperCase()}] ${oneLine(input.title)}${hostname ? `${SEPARATOR}${hostname}` : ''}`;
  return truncateCodePoints(text, budget) + suffix;
}

export interface TicketDescriptionInput {
  alertId: string;
  severity: string;
  title: string;
  message: string | null;
  deviceHostname: string | null;
  siteName: string | null;
  orgName: string | null;
  alertUrl: string;
  triggeredAt: string | null;
}

/** Message, then one fact per line, then the marker line a human can search for. */
export function buildTicketDescription(input: TicketDescriptionInput): string {
  const lines: string[] = [];
  const message = input.message?.replace(CONTROL_CHARS, '').trim();
  if (message) {
    lines.push(truncateCodePoints(message, PSA_TICKET_DESCRIPTION_MAX_MESSAGE), '');
  }
  lines.push(`Severity: ${oneLine(input.severity).toUpperCase()}`);
  lines.push(`Alert title: ${oneLine(input.title)}`);
  if (input.deviceHostname && oneLine(input.deviceHostname)) lines.push(`Device: ${oneLine(input.deviceHostname)}`);
  if (input.siteName && oneLine(input.siteName)) lines.push(`Site: ${oneLine(input.siteName)}`);
  if (input.orgName && oneLine(input.orgName)) lines.push(`Organization: ${oneLine(input.orgName)}`);
  if (input.triggeredAt) lines.push(`Triggered: ${input.triggeredAt}`);
  lines.push(`Alert: ${input.alertUrl}`);
  lines.push('', `Breeze alert reference: breeze-alert:${input.alertId}`);
  return lines.join('\n');
}
