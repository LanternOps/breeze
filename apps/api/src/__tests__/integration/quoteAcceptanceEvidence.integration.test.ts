import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quoteAcceptances } from '../../db/schema/quotes';
import { createPartner, createOrganization, createUser } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { acceptQuote } from '../../services/quoteAcceptService';
import {
  AcceptanceEvidenceError,
  attachAcceptanceEvidence,
  openAcceptanceEvidence,
} from '../../services/quoteAcceptanceEvidence';
import type { QuoteActor } from '../../services/quoteTypes';

// #6633 — the evidence_* columns on quote_acceptances against real Postgres:
// the service round-trip under an org-scoped (RLS) context, the CHECK
// constraints that make "evidence only on an on-behalf row" and the
// backend/bytes shape real invariants, and cross-org invisibility.

const runDb = it.runIf(!!process.env.DATABASE_URL);
function ctxFor(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null };
}
function actorFor(orgId: string, partnerId: string): QuoteActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}

const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\nevidence body', 'latin1');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function acceptedOnBehalf() {
  const { partner, org, tech } = await withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const tech = await createUser({ partnerId: partner.id, orgId: org.id, withMembership: false });
    return { partner, org, tech };
  });
  const ctx = ctxFor(org.id, partner.id);
  const actor = actorFor(org.id, partner.id);
  const quote = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
  await withDbAccessContext(ctx, () => addManualLine(quote.id, {
    sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 100,
    taxable: false, customerVisible: true, recurrence: 'one_time',
  } as never, actor));
  const res = await withSystemDbAccessContext(() => acceptQuote({
    quoteId: quote.id, signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
    ipAddress: null, userAgent: null,
    origin: 'on_behalf', method: 'signed_document', reference: 'Signed SOW 2026-09-22',
    actorUserId: tech.id,
  }));
  return { partner, org, tech, ctx, quoteId: quote.id, acceptanceId: res.acceptanceId };
}

async function rowOf(acceptanceId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, acceptanceId)));
  return row!;
}

async function pgCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try { await fn(); return undefined; } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
}

describe('quote acceptance evidence — real Postgres', () => {
  runDb('attaches, serves and replaces evidence on a CONVERTED quote under an org-scoped context', async () => {
    const { org, tech, ctx, quoteId, acceptanceId } = await acceptedOnBehalf();

    const first = await withDbAccessContext(ctx, () => attachAcceptanceEvidence({
      quoteId, orgId: org.id, actorUserId: tech.id, file: { buffer: PDF, filename: 'SOW signed.pdf' },
    }));
    expect(first.acceptanceId).toBe(acceptanceId);
    expect(first.replaced).toBe(false);

    const row = await rowOf(acceptanceId);
    // No S3 in the test stack → the blob service picks the inline backend.
    expect(row.evidenceStorageBackend).toBe('db');
    expect(row.evidenceStorageKey).toBeNull();
    expect(Buffer.from(row.evidenceData!).equals(PDF)).toBe(true);
    expect(row.evidenceFilename).toBe('SOW signed.pdf');
    expect(row.evidenceContentType).toBe('application/pdf');
    expect(row.evidenceSizeBytes).toBe(PDF.length);
    expect(row.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.evidenceUploadedByUserId).toBe(tech.id);
    expect(row.evidenceUploadedAt).toBeInstanceOf(Date);
    // The acceptance record itself is untouched.
    expect(row.origin).toBe('on_behalf');
    expect(row.reference).toBe('Signed SOW 2026-09-22');

    const opened = await withDbAccessContext(ctx, () => openAcceptanceEvidence({ quoteId, orgId: org.id }));
    expect(Buffer.isBuffer(opened.body) && opened.body.equals(PDF)).toBe(true);
    expect(opened.meta).toMatchObject({ filename: 'SOW signed.pdf', contentType: 'application/pdf', sizeBytes: PDF.length });

    const second = await withDbAccessContext(ctx, () => attachAcceptanceEvidence({
      quoteId, orgId: org.id, actorUserId: tech.id, file: { buffer: PNG, filename: 'po-scan.png' },
    }));
    expect(second.replaced).toBe(true);
    const replaced = await rowOf(acceptanceId);
    expect(replaced.evidenceContentType).toBe('image/png');
    expect(Buffer.from(replaced.evidenceData!).equals(PNG)).toBe(true);
  });

  runDb('two CONCURRENT uploads serialise on the row lock: exactly one sees the other as replaced', async () => {
    const { org, tech, ctx, quoteId, acceptanceId } = await acceptedOnBehalf();
    // Separate transactions racing on the same acceptance row. With the
    // FOR UPDATE, the second reads the first's committed evidence and reports
    // replaced=true; without it both read the empty row and both say false.
    const results = await Promise.all([
      withDbAccessContext(ctx, () => attachAcceptanceEvidence({
        quoteId, orgId: org.id, actorUserId: tech.id, file: { buffer: PDF, filename: 'one.pdf' },
      })),
      withDbAccessContext(ctx, () => attachAcceptanceEvidence({
        quoteId, orgId: org.id, actorUserId: tech.id, file: { buffer: PNG, filename: 'two.png' },
      })),
    ]);
    expect(results.map((r) => r.replaced).sort()).toEqual([false, true]);
    // The row holds whichever committed last — consistently, bytes and metadata together.
    const winner = results.find((r) => r.replaced)!;
    const row = await rowOf(acceptanceId);
    expect(row.evidenceFilename).toBe(winner.evidence.filename);
    expect(Buffer.from(row.evidenceData!).equals(winner.evidence.filename === 'one.pdf' ? PDF : PNG)).toBe(true);
  });

  runDb('another org cannot see the acceptance to attach to or read from (RLS)', async () => {
    const a = await acceptedOnBehalf();
    const b = await acceptedOnBehalf();
    await withDbAccessContext(a.ctx, () => attachAcceptanceEvidence({
      quoteId: a.quoteId, orgId: a.org.id, actorUserId: a.tech.id, file: { buffer: PDF, filename: 'a.pdf' },
    }));

    // Org B's context, naming org A's quote and org — RLS hides the row.
    const attach = withDbAccessContext(b.ctx, () => attachAcceptanceEvidence({
      quoteId: a.quoteId, orgId: a.org.id, actorUserId: b.tech.id, file: { buffer: PNG, filename: 'b.png' },
    }));
    await expect(attach).rejects.toMatchObject({ code: 'QUOTE_NOT_ACCEPTED' });
    const read = withDbAccessContext(b.ctx, () => openAcceptanceEvidence({ quoteId: a.quoteId, orgId: a.org.id }));
    await expect(read).rejects.toBeInstanceOf(AcceptanceEvidenceError);
    expect((await rowOf(a.acceptanceId)).evidenceFilename).toBe('a.pdf');
  });

  runDb('CHECK: a customer acceptance can never carry evidence (23514)', async () => {
    const { acceptanceId } = await acceptedOnBehalf();
    // Flip the fixture row to a customer acceptance (recorder cleared to keep
    // quote_acceptances_recorder_chk satisfied), then try to add evidence.
    await withSystemDbAccessContext(() => db.update(quoteAcceptances)
      .set({ origin: 'customer', recordedByUserId: null }).where(eq(quoteAcceptances.id, acceptanceId)));
    const code = await pgCode(() => withSystemDbAccessContext(() => db.update(quoteAcceptances).set({
      evidenceStorageBackend: 'db', evidenceData: PDF, evidenceFilename: 'x.pdf',
      evidenceContentType: 'application/pdf', evidenceSizeBytes: PDF.length,
      evidenceSha256: 'a'.repeat(64), evidenceUploadedAt: new Date(),
    }).where(eq(quoteAcceptances.id, acceptanceId))));
    expect(code).toBe('23514');
  });

  runDb('CHECK: backend and bytes must agree, and the metadata is all-or-nothing (23514)', async () => {
    const { acceptanceId } = await acceptedOnBehalf();
    const base = {
      evidenceFilename: 'x.pdf', evidenceContentType: 'application/pdf', evidenceSizeBytes: PDF.length,
      evidenceSha256: 'a'.repeat(64), evidenceUploadedAt: new Date(),
    };
    const set = (v: Record<string, unknown>) => pgCode(() => withSystemDbAccessContext(() =>
      db.update(quoteAcceptances).set(v).where(eq(quoteAcceptances.id, acceptanceId))));

    // 'db' backend without inline bytes.
    expect(await set({ ...base, evidenceStorageBackend: 'db', evidenceData: null })).toBe('23514');
    // 's3' backend without a key.
    expect(await set({ ...base, evidenceStorageBackend: 's3', evidenceStorageKey: null })).toBe('23514');
    // 's3' backend carrying inline bytes too.
    expect(await set({ ...base, evidenceStorageBackend: 's3', evidenceStorageKey: 'quote-acceptance-evidence/k', evidenceData: PDF })).toBe('23514');
    // Metadata without a backend.
    expect(await set({ evidenceFilename: 'orphan.pdf' })).toBe('23514');
    // An unknown backend.
    expect(await set({ ...base, evidenceStorageBackend: 'gcs', evidenceStorageKey: 'k' })).toBe('23514');
    // And the valid s3 shape is accepted.
    expect(await set({ ...base, evidenceStorageBackend: 's3', evidenceStorageKey: 'quote-acceptance-evidence/k' })).toBeUndefined();
  });

  runDb('deleting the uploader nulls evidence_uploaded_by_user_id without disturbing the evidence', async () => {
    const { partner, org, ctx, quoteId, acceptanceId } = await acceptedOnBehalf();
    // A different tech attaches the file than the one who recorded the
    // acceptance (that one also created the invoice, which restricts delete).
    const uploader = await withSystemDbAccessContext(() =>
      createUser({ partnerId: partner.id, orgId: org.id, withMembership: false }));
    await withDbAccessContext(ctx, () => attachAcceptanceEvidence({
      quoteId, orgId: org.id, actorUserId: uploader.id, file: { buffer: PDF, filename: 'a.pdf' },
    }));
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM users WHERE id = ${uploader.id}`));
    const row = await rowOf(acceptanceId);
    expect(row.evidenceUploadedByUserId).toBeNull();
    expect(row.evidenceFilename).toBe('a.pdf');
  });
});
