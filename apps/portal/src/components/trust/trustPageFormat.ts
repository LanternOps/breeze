import {
  FRAMEWORK_CROSSWALK,
  FRAMEWORK_META,
  SUPPORTED_LOCALES,
  TRUST_CONTROL_CATEGORY_ORDER,
  trustCopyFor,
  type FrameworkRef,
  type TelemetryControlId,
  type TrustControlCategory,
  type TrustControlStatus,
  type TrustNotAssessedReason,
  type TrustPagePublicControl,
} from '@breeze/shared';
import { pageCopy } from './copy/pageCopy';
import { pickTrustCopy } from './trustCopy';

// Every formatter takes the page's frozen locale (payload.locale) as its last argument; an unknown or missing
// locale renders English (pickTrustCopy / trustCopyFor), so a W1 page and a bad value both stay readable.

export function groupControlsByCategory(
  controls: TrustPagePublicControl[],
  locale?: string | null,
): Array<{ category: TrustControlCategory; label: string; controls: TrustPagePublicControl[] }> {
  const categories = trustCopyFor(locale).categories;
  return TRUST_CONTROL_CATEGORY_ORDER
    .map((category) => ({ category, label: categories[category], controls: controls.filter((c) => c.category === category) }))
    .filter((g) => g.controls.length > 0);
}

export function controlCopy(id: TelemetryControlId, locale?: string | null): { title: string; description: string } {
  return trustCopyFor(locale).controls[id] ?? { title: id, description: '' };
}

function unitNoun(unit: TrustPagePublicControl['unit'], locale?: string | null): string {
  const c = pickTrustCopy(pageCopy, locale);
  return unit === 'devices' ? c.unitDevices : unit === 'users' ? c.unitUsers : c.unitSources;
}

export function coverageNote(c: TrustPagePublicControl, locale?: string | null): string | null {
  if (c.assessed == null || c.eligible == null) return null;
  return pickTrustCopy(pageCopy, locale).coverage(c.assessed, c.eligible, unitNoun(c.unit, locale));
}

export function frameworkChip(ref: FrameworkRef, locale?: string | null): string {
  const meta = FRAMEWORK_META[ref.framework];
  if (ref.framework === 'cis_v8') {
    // Implementation-group tiers are language-neutral: they come from the crosswalk, not the copy.
    const ig = FRAMEWORK_CROSSWALK.cis_v8[ref.ref]?.ig;
    return `${meta.shortName} ${ref.ref}${ig ? ` · IG${ig}` : ''}`;
  }
  return `${meta.shortName}: ${trustCopyFor(locale).crosswalk[ref.framework]?.[ref.ref] ?? ref.ref}`;
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

export function relativeTime(iso: string | null, now: Date = new Date(), locale?: string | null): string {
  const c = pickTrustCopy(pageCopy, locale);
  if (!iso) return c.never;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return c.never;
  const secs = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (secs < MINUTE) return c.justNow;
  const rtf = new Intl.RelativeTimeFormat(safeLocale(locale), { numeric: 'always', style: 'long' });
  if (secs < HOUR) return rtf.format(-Math.floor(secs / MINUTE), 'minute');
  if (secs < DAY) return rtf.format(-Math.floor(secs / HOUR), 'hour');
  return rtf.format(-Math.floor(secs / DAY), 'day');
}

function safeLocale(locale?: string | null): string {
  try { return Intl.getCanonicalLocales(locale ?? 'en')[0] ?? 'en'; } catch { return 'en'; }
}

/** Date and time in the page's locale; '' when the value does not parse (callers fall back to copy). */
export function formatTrustDateTime(iso: string, locale?: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(safeLocale(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

/** <title>, description and <html lang> for the SSR shell, from the card (null = card fetch failed → English). */
export function cardMeta(
  card: { orgName: string; locale: string; controlsShown: number; catalogTotal: number; controlsMet: number } | null,
): { lang: string; title: string; description: string; signedCopy: string; verificationKeys: string } {
  const t = pickTrustCopy(pageCopy, card?.locale);
  const lang = card ? safeLocale(isKnownLocale(card.locale) ? card.locale : 'en') : 'en';
  return {
    lang,
    title: card ? `${card.orgName} · ${t.headerSuffix}` : t.pageTitle,
    description: card ? t.cardDescription(card.controlsShown, card.catalogTotal, card.controlsMet) : t.genericDescription,
    signedCopy: t.signedCopy,
    verificationKeys: t.verificationKeys,
  };
}

function isKnownLocale(l: string): boolean {
  return (SUPPORTED_LOCALES as readonly string[]).includes(l);
}

export function statusLabel(status: TrustControlStatus, locale?: string | null): string {
  return trustCopyFor(locale).statuses[status];
}

export function notAssessedReasonCopy(
  reason: TrustNotAssessedReason,
  ctx: { coverageFloorPct: number; unit: TrustPagePublicControl['unit'] },
  locale?: string | null,
): string {
  const c = pickTrustCopy(pageCopy, locale);
  switch (reason) {
    case 'insufficient_telemetry': return c.reasonInsufficient(ctx.coverageFloorPct, unitNoun(ctx.unit, locale));
    case 'no_data': return c.reasonNoData;
    case 'not_applicable': return c.reasonNotApplicable;
  }
}
