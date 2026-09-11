import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const h = vi.hoisted(() => ({
  scriptRow: null as Record<string, unknown> | null,
  forUpdateCalled: false,
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('../db', () => ({
  db: {
    transaction: vi.fn(),
    select: vi.fn(),
  },
}));

function buildTx() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          for: vi.fn((mode: string) => {
            h.forUpdateCalled = mode === 'update';
            return { limit: vi.fn(() => Promise.resolve(h.scriptRow ? [h.scriptRow] : [])) };
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        h.updates.push(values);
        return { where: vi.fn(() => Promise.resolve(undefined)) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        h.inserts.push(values);
        return { returning: vi.fn(() => Promise.resolve([{ id: 'version-row', ...values }])) };
      }),
    })),
  };
}

import { sha256Content, cutScriptVersion, ScriptVersionCutError } from './scriptVersions';

function rawSha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('sha256Content', () => {
  it('returns a 64-char lowercase hex digest', () => {
    expect(sha256Content('Write-Host "hi"')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats CRLF and LF line endings as the same content', () => {
    expect(sha256Content('a\r\nb\r\nc')).toBe(sha256Content('a\nb\nc'));
  });

  it('treats NFD and NFC forms of the same text as identical', () => {
    // "é" as U+00E9 vs "e" + U+0301
    expect(sha256Content('café')).toBe(sha256Content('café'));
  });

  it('does NOT trim — trailing whitespace is part of the content', () => {
    expect(sha256Content('echo hi')).not.toBe(sha256Content('echo hi  '));
  });

  it('agrees with a plain sha256 of the already-canonical form', () => {
    expect(sha256Content('a\nb')).toBe(rawSha('a\nb'));
  });

  it('distinguishes a lone CR from a newline (only CRLF is folded)', () => {
    expect(sha256Content('a\rb')).not.toBe(sha256Content('a\nb'));
  });
});

const SCRIPT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  h.scriptRow = {
    id: SCRIPT_ID,
    version: 4,
    content: 'Write-Host "after"\r\n',
    language: 'powershell',
    timeoutSeconds: 600,
    runAs: 'elevated',
    parameters: [{ name: 'Target', type: 'string' }],
  };
  h.forUpdateCalled = false;
  h.updates = [];
  h.inserts = [];
});

describe('cutScriptVersion', () => {
  it('locks the script row FOR UPDATE before reading it', async () => {
    await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: { origin: 'human', createdBy: USER_ID },
    });
    expect(h.forUpdateCalled).toBe(true);
  });

  it('increments scripts.version and snapshots the AFTER image at the new number', async () => {
    const row = await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: { origin: 'human', createdBy: USER_ID },
    });
    expect(h.updates[0]).toMatchObject({ version: 5 });
    expect(h.inserts[0]).toMatchObject({
      scriptId: SCRIPT_ID,
      version: 5,
      content: 'Write-Host "after"\r\n',
      language: 'powershell',
      timeoutSeconds: 600,
      runAs: 'elevated',
    });
    expect(row.version).toBe(5);
  });

  it('stores the canonical digest of the content it snapshotted', async () => {
    await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: { origin: 'human', createdBy: USER_ID },
    });
    expect(h.inserts[0]!.contentDigest).toBe(sha256Content('Write-Host "after"\r\n'));
  });

  it('carries the full provenance onto the row', async () => {
    const reviewedAt = new Date('2026-09-11T10:00:00Z');
    const approvedAt = new Date('2026-09-11T10:05:00Z');
    await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: {
        origin: 'ai_proposal',
        proposalId: '33333333-3333-4333-8333-333333333333',
        reviewId: '44444444-4444-4444-8444-444444444444',
        reviewedAt,
        approvedBy: USER_ID,
        approvedAt,
        approvalMethod: 'four_eyes',
        changelog: 'Approved proposal',
        createdBy: USER_ID,
      },
    });
    expect(h.inserts[0]).toMatchObject({
      origin: 'ai_proposal',
      proposalId: '33333333-3333-4333-8333-333333333333',
      reviewId: '44444444-4444-4444-8444-444444444444',
      reviewedAt,
      approvedBy: USER_ID,
      approvedAt,
      approvalMethod: 'four_eyes',
      changelog: 'Approved proposal',
      createdBy: USER_ID,
    });
  });

  it('defaults every optional provenance field to null rather than undefined', async () => {
    await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: { origin: 'system', createdBy: null },
    });
    expect(h.inserts[0]).toMatchObject({
      proposalId: null,
      reviewId: null,
      reviewedAt: null,
      approvedBy: null,
      approvedAt: null,
      approvalMethod: null,
      changelog: null,
      createdBy: null,
    });
  });

  it('throws ScriptVersionCutError when the script row is not visible', async () => {
    h.scriptRow = null;
    await expect(
      cutScriptVersion(buildTx() as never, {
        scriptId: SCRIPT_ID,
        provenance: { origin: 'human', createdBy: USER_ID },
      })
    ).rejects.toBeInstanceOf(ScriptVersionCutError);
  });

  it('takes a freshly-created script from version 0 to version 1', async () => {
    h.scriptRow = { ...h.scriptRow, version: 0 };
    const row = await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: { origin: 'human', createdBy: USER_ID },
    });
    expect(row.version).toBe(1);
    expect(h.updates[0]).toMatchObject({ version: 1 });
  });
});
