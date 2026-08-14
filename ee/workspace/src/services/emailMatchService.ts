// Tiered .eml matcher for the Outlook filing panel (W4). Given the subject,
// sender, date, and (when Graph hands us one) internetMessageId of the
// message currently open in Outlook, answer which crawled .eml file in the
// estate it is — or null.
//
// Tier 1 (messageId) is the strongest signal but the demo corpus (PO-4021)
// carries no Message-ID header at all, which is exactly the case tiers 2/3
// exist for: never assume tier 1 alone is enough coverage.
//   1 = messageId equality.
//   2 = normalizedSubject + sender email + |date - email_meta.date| <= 7d.
//   3 = normalizedSubject + date window only (catches forwards, where the
//       sender changes but the subject and rough timing survive).
// The first tier with EXACTLY ONE candidate wins. Zero or multiple
// candidates in a tier means "try the next tier"; null when every tier
// misses. Tier 3's candidate set is a superset of tier 2's (same subject +
// date window, sender unconstrained), so an ambiguous tier 2 is also
// ambiguous at tier 3 — it falls all the way through to null, not to some
// arbitrary pick.
import { sql } from 'drizzle-orm';
import type { WorkspaceDatabase } from '../hostTypes';
import { visibleSourcePredicateSql } from './visibility';

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

export interface EmailProbe {
  subject: string;
  sender?: string;
  dateISO?: string;
  internetMessageId?: string;
}

export type EmailMatch = { fileIndexId: string; tier: 1 | 2 | 3 };

interface CandidateRow {
  id: string;
  email_meta: { subject?: string; from?: string; date?: string } | null;
}

/** Strip repeated leading re:/fw:/fwd: (case-insensitive), collapse whitespace,
 * casefold, trim. Only a labeled "word:" prefix is stripped — "REISSUE: ..."
 * is untouched because "reissue" isn't one of the three tokens. */
export function normalizeSubject(s: string): string {
  let out = s ?? '';
  let prev: string;
  do {
    prev = out;
    out = out.replace(/^\s*(?:re|fw|fwd)\s*:\s*/i, '');
  } while (out !== prev);
  return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Same normalization extract.ts applies when it captures parsed.messageId:
 * angle brackets stripped, lowercased. Applied here to the probe's id so it
 * compares equal to what was persisted at ingest time. */
function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<+|>+$/g, '').toLowerCase();
}

/** Bare lowercase email address out of either a raw address or a "Name
 * <addr>" mailbox string (the shape mailparser's AddressObject#text produces,
 * which is what email_meta.from / the probe's sender carry). */
function senderEmail(text: string | undefined): string | null {
  if (!text) return null;
  const angle = text.match(/<([^>]+)>/);
  // The capture group is structurally guaranteed by the match above.
  const raw = (angle?.[1] ?? text).trim().toLowerCase();
  return raw || null;
}

export function createEmailMatchService(db: WorkspaceDatabase) {
  const d = db;

  async function tier1Candidates(
    orgId: string, groupIds: string[], normalizedMessageId: string,
  ): Promise<Array<{ id: string }>> {
    return await d.execute(sql`
      SELECT fi.id
      FROM workspace_file_index fi
      JOIN workspace_file_enrichment en ON en.file_index_id = fi.id
      JOIN workspace_sources s ON s.id = fi.source_id AND s.org_id = fi.org_id
      WHERE fi.org_id = ${orgId}
        AND fi.ext = 'eml'
        AND fi.deleted_at IS NULL
        AND ${visibleSourcePredicateSql(sql, groupIds)}
        AND en.email_meta ->> 'messageId' = ${normalizedMessageId}
    `) as unknown as Array<{ id: string }>;
  }

  /** Rows within the 7-day window of the probe date, org-bound and visibility-
   * gated. Subject/sender agreement is decided in JS (below) against these —
   * normalizeSubject's repeated-prefix stripping isn't worth reproducing as
   * a SQL predicate. */
  async function dateWindowCandidates(
    orgId: string, groupIds: string[], dateISO: string,
  ): Promise<CandidateRow[]> {
    return await d.execute(sql`
      SELECT fi.id, en.email_meta
      FROM workspace_file_index fi
      JOIN workspace_file_enrichment en ON en.file_index_id = fi.id
      JOIN workspace_sources s ON s.id = fi.source_id AND s.org_id = fi.org_id
      WHERE fi.org_id = ${orgId}
        AND fi.ext = 'eml'
        AND fi.deleted_at IS NULL
        AND ${visibleSourcePredicateSql(sql, groupIds)}
        AND en.email_meta IS NOT NULL
        AND en.email_meta ->> 'date' IS NOT NULL
        AND abs(extract(epoch from ((en.email_meta ->> 'date')::timestamptz - ${dateISO}::timestamptz)))
          <= ${SEVEN_DAYS_SECONDS}
    `) as unknown as CandidateRow[];
  }

  return {
    normalizeSubject,

    async match(orgId: string, probe: EmailProbe, groupIds: string[] = []): Promise<EmailMatch | null> {
      if (probe.internetMessageId) {
        const rows = await tier1Candidates(orgId, groupIds, normalizeMessageId(probe.internetMessageId));
        if (rows.length === 1) return { fileIndexId: rows[0]!.id, tier: 1 };
      }

      if (!probe.dateISO) return null;

      const candidates = await dateWindowCandidates(orgId, groupIds, probe.dateISO);
      const probeSubject = normalizeSubject(probe.subject);
      const probeSender = senderEmail(probe.sender);
      const subjectMatches = candidates.filter(
        (c) => normalizeSubject(c.email_meta?.subject ?? '') === probeSubject,
      );

      if (probeSender) {
        const tier2 = subjectMatches.filter((c) => senderEmail(c.email_meta?.from) === probeSender);
        if (tier2.length === 1) return { fileIndexId: tier2[0]!.id, tier: 2 };
      }

      if (subjectMatches.length === 1) return { fileIndexId: subjectMatches[0]!.id, tier: 3 };

      return null;
    },
  };
}

export type EmailMatchService = ReturnType<typeof createEmailMatchService>;
