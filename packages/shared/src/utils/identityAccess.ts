import type { SigninCoverage } from '../types/identityAccessReport';

/**
 * Shared arithmetic for the Identity & Access Review report (#5784 W06).
 *
 * Lives in `packages/shared` because the API generator, the PDF renderer and the
 * web preview must agree on what "unmeasured" means. Every helper here exists to
 * stop a null being rendered as a zero: the difference between "we did not
 * measure this" and "this is zero" is the whole difference between an honest
 * evidence artifact and a misleading one.
 */

/**
 * Graph `clientAppUsed` values that indicate LEGACY authentication (basic auth
 * over a protocol that cannot carry a modern token), as documented for the
 * sign-in logs' "Client app" filter:
 * https://learn.microsoft.com/en-us/entra/identity/monitoring-health/concept-sign-ins
 * — "Legacy authentication clients" lists exactly these values, versus the
 * modern-auth values "Browser" and "Mobile Apps and Desktop clients".
 *
 * Matched verbatim against the stored string. A value Graph adds later is simply
 * not counted as legacy, which is the safe direction: this figure is presented
 * as "legacy authentication observed", never as "legacy authentication is off".
 */
export const LEGACY_AUTH_CLIENT_APPS: ReadonlySet<string> = new Set([
  'Other clients',
  'IMAP4',
  'POP3',
  'SMTP',
  'MAPI Over HTTP',
  'Offline Address Book',
  'Outlook Anywhere (RPC over HTTP)',
  'Exchange Web Services',
  'Exchange ActiveSync',
  'Authenticated SMTP',
  'AutoDiscover',
  'Reporting Web Services',
  'Exchange Online PowerShell',
]);

/** Values Graph returns in a risk field that are NOT a measurement. */
const UNMEASURED_RISK_VALUES: ReadonlySet<string> = new Set([
  // Without Entra ID P2 the risk fields come back as this sentinel. It means
  // "you are not licensed to see this", NOT "no risk".
  'hidden',
  // Forward-compatibility placeholder; carries no risk information.
  'unknownFutureValue',
]);

/**
 * True when a risk value is an actual measurement.
 *
 * `'none'` IS a measurement — the tenant has P2 and Graph assessed no risk — and
 * must be counted. `'hidden'` is not: rendering it as a risk level (or folding it
 * into a "no risk detected" claim) tells a customer their tenant was assessed
 * when it never was.
 */
export function isRiskFieldMeasured(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return !UNMEASURED_RISK_VALUES.has(trimmed);
}

/**
 * Count of sign-ins from outside the configured home countries.
 *
 * Returns **null** when no home countries are configured. "Not configured" and
 * "no foreign sign-ins" are different facts and must not render the same: a
 * zero here would tell a customer their staff signed in only from home when
 * nobody ever said where home is. Rows with an unknown location are ignored
 * rather than counted as foreign.
 */
export function foreignCountrySignins(
  rows: ReadonlyArray<{ locationCountry: string | null }>,
  homeCountries: readonly string[],
): number | null {
  if (homeCountries.length === 0) return null;
  const home = new Set(homeCountries.map((code) => code.trim().toUpperCase()));
  let count = 0;
  for (const row of rows) {
    const country = row.locationCountry?.trim().toUpperCase();
    if (!country) continue;
    if (!home.has(country)) count += 1;
  }
  return count;
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

/**
 * One human sentence naming every way the sign-in data falls short of the period
 * the report claims to cover. Empty string when it does not fall short.
 *
 * The three shortfalls, in the order a reader needs them:
 *  1. The tenant has no Entra ID P1/P2, so Graph never released the sign-in logs
 *     at all. The permission was granted; the licence was not.
 *  2. Breeze holds no events for the period — Graph retains sign-in logs for only
 *     ~30 days and Breeze accumulates forward from first sync, so the first
 *     report after enabling can legitimately be empty. It says so rather than
 *     claiming nobody signed in.
 *  3. Collection began (or stopped) inside the period, so the window the report
 *     actually covers is shorter than the window it is filed against.
 */
export function signinCoverageLine(coverage: SigninCoverage): string {
  if (coverage.unlicensed === true) {
    return 'Microsoft did not release sign-in logs for this tenant: downloading them '
      + 'requires an Entra ID P1 or P2 licence, which this tenant does not have. '
      + 'This is a licensing gap, not a statement about sign-in activity.';
  }

  const parts: string[] = [];
  const { periodStart, periodEnd, coveredFrom, coveredTo } = coverage;

  if (!coveredFrom) {
    parts.push(
      'Breeze holds no interactive sign-in events for this period. Microsoft retains '
      + 'sign-in logs for about 30 days and Breeze accumulates them forward from the '
      + 'first sync, so a period that predates collection cannot be recovered.',
    );
  } else {
    const startsLate = periodStart !== undefined && dateOnly(coveredFrom) > dateOnly(periodStart);
    const endsEarly = periodEnd !== undefined && coveredTo != null
      && dateOnly(coveredTo) < dateOnly(periodEnd);
    if (startsLate || endsEarly) {
      parts.push(
        `This report does not cover the whole period: the interactive sign-in events `
        + `Breeze holds span ${dateOnly(coveredFrom)}`
        + `${coveredTo ? ` to ${dateOnly(coveredTo)}` : ''}`
        + `${periodStart && periodEnd ? `, inside a period of ${dateOnly(periodStart)} to ${dateOnly(periodEnd)}` : ''}.`,
      );
    }
  }

  if (coverage.gapNote) parts.push(coverage.gapNote);

  return parts.join(' ');
}
