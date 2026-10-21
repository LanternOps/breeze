import type { DocumentDate } from './model';

const OPTIONS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' };

/**
 * A stored calendar date (`YYYY-MM-DD`) for the document. It is formatted at UTC
 * midnight in UTC, so neither the host's nor the viewer's timezone can shift the
 * day. `iso` is the input, unchanged, for `<time dateTime>`. A value that is not
 * a calendar date is passed through as its own text rather than throwing.
 */
export function documentDate(iso: string, locale: string): DocumentDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { text: iso, iso };
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return { text: iso, iso };
  let text: string;
  try {
    text = new Intl.DateTimeFormat(locale, OPTIONS).format(d);
  } catch {
    text = new Intl.DateTimeFormat('en', OPTIONS).format(d);
  }
  return { text, iso };
}
