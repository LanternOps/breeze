// Pure logic for the verify-acceptance-hashes script (#8865 W1a), split out so
// it can be unit tested without a database: argv validation and the summary /
// exit-code decision. All I/O stays in verify-acceptance-hashes.ts.

import { UUID } from './link-evidence-reports.lib';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 5000;

export type ParsedVerifyArgs = { limit: number; orgId?: string; partnerId?: string; since?: string };

/** One recomputed acceptance. `error` is set when the row could not be
 *  recomputed at all (acceptance/quote gone, unsupported hash version, a DB
 *  failure); such a row is never counted as a match or a mismatch.
 *  `hashVersion` is the stored quote_acceptances.hash_version — a number rather
 *  than 1 | 2 because an unsupported stored version is exactly what an error
 *  row may report. */
export type VerifyOutcome = {
  acceptanceId: string;
  quoteId: string;
  hashVersion: number;
  renderLocale: string;
  matches: boolean;
  error?: string;
};

export type VerifySummary = {
  checked: number;
  matches: number;
  mismatches: number;
  errors: number;
  /** 0 all match (or nothing to check); 1 at least one mismatch; 2 no mismatch but at least one error. */
  exitCode: 0 | 1 | 2;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  // A flag followed by nothing (or by another flag) has no value — report it
  // under the flag's own name rather than silently treating it as absent.
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} requires a value`);
  return v;
}

const KNOWN_FLAGS = new Set(['--limit', '--org-id', '--partner-id', '--since']);

/** Reject anything that is not `--known-flag value`: a typo'd flag
 *  (`--limt 500`), the `--limit=500` form, or a stray positional would
 *  otherwise be ignored and silently narrow a post-deploy gate. */
function assertOnlyKnownFlags(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!KNOWN_FLAGS.has(tok)) {
      throw new Error(`unknown argument ${JSON.stringify(tok)} (expected --limit N, --org-id <uuid>, --partner-id <uuid>, --since <ISO date>)`);
    }
    i++; // skip the value; flagValue validates presence
  }
}

export function parseVerifyArgs(argv: string[]): ParsedVerifyArgs {
  assertOnlyKnownFlags(argv);
  const out: ParsedVerifyArgs = { limit: DEFAULT_LIMIT };

  const rawLimit = flagValue(argv, 'limit');
  if (rawLimit !== undefined) {
    // Digits only — Number() would accept 0x10 / 1e2 / ' 5 '.
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) throw new Error('--limit must be a positive integer');
    out.limit = Math.min(Number(rawLimit), MAX_LIMIT);
  }

  const orgId = flagValue(argv, 'org-id');
  if (orgId !== undefined) {
    if (!UUID.test(orgId)) throw new Error('--org-id must be a UUID');
    out.orgId = orgId;
  }

  const partnerId = flagValue(argv, 'partner-id');
  if (partnerId !== undefined) {
    if (!UUID.test(partnerId)) throw new Error('--partner-id must be a UUID');
    out.partnerId = partnerId;
  }

  const since = flagValue(argv, 'since');
  if (since !== undefined) {
    if (!ISO_DATE.test(since) || Number.isNaN(Date.parse(since))) {
      throw new Error('--since must be an ISO date (YYYY-MM-DD or a full ISO timestamp)');
    }
    out.since = since;
  }

  return out;
}

export function summarize(outcomes: VerifyOutcome[]): VerifySummary {
  let matches = 0;
  let mismatches = 0;
  let errors = 0;
  for (const o of outcomes) {
    if (o.error !== undefined) errors++;
    else if (o.matches) matches++;
    else mismatches++;
  }
  const exitCode: 0 | 1 | 2 = mismatches > 0 ? 1 : errors > 0 ? 2 : 0;
  return { checked: outcomes.length, matches, mismatches, errors, exitCode };
}
