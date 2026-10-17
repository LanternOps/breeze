import { escapeHtml, renderLayout, renderLinkRow, renderParagraph } from '../emailLayout';
import { localAgeDays, type DigestIncident, type UserDigestPlan } from './digestPlan';

// Daily connection health digest email (spec 2026-10-15 §4, §5, §7). English
// only, like all platform staff mail. Every interpolated value is escaped;
// `detail` was sanitized at write time (§7) and is escaped again here.

/**
 * English condition labels. Mirrors the web panel's `connectionHealthPanel.condition.*`
 * strings; conditions.contract.test.ts fails when a source emits a code missing here.
 */
export const DIGEST_CONDITION_LABELS: Readonly<Record<string, string>> = {
  sync_failed: 'Sync failed',
  reauth_required: 'Re-authorization required',
  disconnected: 'Disconnected',
  error: 'Error',
  mailbox_error: 'Mailbox error',
  poll_failing: 'Polling failing',
  needs_consent: 'Consent needed',
  degraded: 'Degraded',
  suspended: 'Suspended',
  grant_missing: 'Grant missing',
  grant_unexpected: 'Unexpected grant',
  manifest_stale: 'Manifest out of date',
  application_token_invalid: 'Application token invalid',
  tenant_mismatch: 'Tenant mismatch',
  grant_reconciliation_unavailable: 'Grant check unavailable',
  grant_revoked_reuse: 'Grant revoked (token reuse)',
  grant_revoked: 'Grant revoked',
};

export function conditionLabel(code: string): string {
  return Object.prototype.hasOwnProperty.call(DIGEST_CONDITION_LABELS, code)
    ? DIGEST_CONDITION_LABELS[code]!
    : 'Needs attention';
}

export type DigestEmailContext = {
  plan: UserDigestPlan;
  now: Date;
  timeZone: string;
  /** Absolute origin of the web app; fix links are appBaseUrl + fixHref. */
  appBaseUrl: string;
  /** Absolute one-click unsubscribe URL (also the List-Unsubscribe target). */
  unsubscribeUrl: string;
};

const PARTNER_WIDE = 'Partner-wide connections';
const PROFILE_PATH = '/settings/profile';
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function ageText(i: DigestIncident, now: Date, timeZone: string): string {
  const days = localAgeDays(i.openedAt, now, timeZone);
  return days === 0 ? 'opened today' : `open ${plural(days, 'day', 'days')}`;
}

function groupByOrg(rows: readonly DigestIncident[]): Array<{ heading: string; rows: DigestIncident[] }> {
  const groups: Array<{ key: string; heading: string; rows: DigestIncident[] }> = [];
  for (const r of rows) {
    const key = r.orgId ?? '';
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, heading: r.orgId ? (r.orgName ?? 'Organization') : PARTNER_WIDE, rows: [] };
      groups.push(g);
    }
    g.rows.push(r);
  }
  return groups;
}

export function digestSubject(plan: UserDigestPlan): string {
  const n = plan.open.length;
  if (n > 0) return `Connection health: ${plural(n, 'connection needs', 'connections need')} attention`;
  return `Connection health: ${plural(plan.restored.length, 'connection', 'connections')} restored`;
}

export function buildDigestEmail(ctx: DigestEmailContext): { subject: string; html: string; text: string } {
  const { plan, now, timeZone, appBaseUrl, unsubscribeUrl } = ctx;
  const subject = digestSubject(plan);
  const fixUrl = (i: DigestIncident) => `${appBaseUrl}${i.fixHref}`;
  const profileUrl = `${appBaseUrl}${PROFILE_PATH}`;

  const html: string[] = [];
  const text: string[] = [subject, ''];

  if (plan.open.length > 0) {
    html.push(renderParagraph('These connections are not working. Each one clears itself once it recovers.'));
    text.push('These connections are not working. Each one clears itself once it recovers.', '');
    for (const g of groupByOrg(plan.open)) {
      html.push(renderParagraph(`<strong>${escapeHtml(g.heading)}</strong>`, { marginTop: 16 }));
      text.push(g.heading);
      for (const i of g.rows) {
        const meta = `${conditionLabel(i.condition)} · ${ageText(i, now, timeZone)}`;
        const detail = i.detail ? `<br />${escapeHtml(i.detail)}` : '';
        html.push(renderParagraph(
          `${escapeHtml(i.displayName)} — ${escapeHtml(meta)}${detail}<br />`
          + `<a href="${escapeHtml(fixUrl(i))}">Fix</a>`,
        ));
        text.push(`- ${i.displayName} — ${meta}`);
        if (i.detail) text.push(`  ${i.detail}`);
        text.push(`  Fix: ${fixUrl(i)}`);
      }
      text.push('');
    }
  }

  if (plan.restored.length > 0) {
    html.push(renderParagraph('<strong>Restored since your last digest</strong>', { marginTop: 16 }));
    text.push('Restored since your last digest');
    for (const i of plan.restored) {
      const where = i.orgId ? (i.orgName ?? 'Organization') : PARTNER_WIDE;
      html.push(renderParagraph(`${escapeHtml(i.displayName)} — ${escapeHtml(where)}`));
      text.push(`- ${i.displayName} — ${where}`);
    }
    text.push('');
  }

  const why = 'You receive this because you can fix these connections in Breeze. At most one digest is sent a day.';
  html.push(renderParagraph(escapeHtml(why), { muted: true, marginTop: 16 }));
  html.push(renderLinkRow([
    { label: 'Unsubscribe from this digest', url: unsubscribeUrl },
    { label: 'Email preferences', url: profileUrl },
  ]));
  text.push(why, `Unsubscribe: ${unsubscribeUrl}`, `Email preferences: ${profileUrl}`);

  const preheader = plan.open.length > 0
    ? plan.open.slice(0, 3).map((i) => i.displayName).join(', ')
    : 'Connections restored since your last digest';

  return {
    subject,
    html: renderLayout({ title: subject, preheader, heading: subject, body: html.join('\n') }),
    text: text.join('\n'),
  };
}
