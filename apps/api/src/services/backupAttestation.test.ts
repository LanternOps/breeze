import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_ATTESTATION_MAX_BYTES,
  expectedControlKey,
  parseAttestationStatement,
} from './backupAttestation';

type Vector = { name: string; statement: string; valid: boolean; sha256?: string; reason?: string; note: string };

// Shared with the helper (agent/internal/backup/attestation_test.go pins the
// same file): edit the fixture, not either implementation.
const vectors: Vector[] = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../../agent/internal/backup/testdata/attestation-vectors.json'),
    'utf8',
  ),
);

describe('parseAttestationStatement (shared vectors)', () => {
  it('loaded the shared fixture with valid and invalid cases', () => {
    expect(vectors.filter((v) => v.valid).length).toBeGreaterThanOrEqual(4);
    expect(vectors.filter((v) => !v.valid).length).toBeGreaterThanOrEqual(15);
  });

  for (const vector of vectors) {
    it(`${vector.valid ? 'accepts' : 'refuses'}: ${vector.name}`, () => {
      const parsed = parseAttestationStatement(vector.statement);
      if (vector.valid) {
        expect(parsed).toMatchObject({ ok: true });
        if (!parsed.ok) return;
        expect(parsed.sha256).toBe(vector.sha256);
        // The digest is over the statement bytes exactly as received.
        expect(parsed.sha256).toBe(createHash('sha256').update(vector.statement, 'utf8').digest('hex'));
        return;
      }
      expect(parsed).toEqual({ ok: false, reason: vector.reason });
    });
  }
});

describe('parseAttestationStatement', () => {
  it('refuses a non-string statement', () => {
    expect(parseAttestationStatement(42 as unknown as string)).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('measures the size limit in UTF-8 bytes', () => {
    expect(SNAPSHOT_ATTESTATION_MAX_BYTES).toBe(16 * 1024);
    // 8200 two-byte characters = 16400 bytes but only 8200 UTF-16 units.
    const raw = `{"v":1,"agentId":"${'é'.repeat(8200)}"}`;
    expect(parseAttestationStatement(raw)).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('expectedControlKey', () => {
  it('names each control object under the snapshot prefix', () => {
    expect(expectedControlKey('s1', 'manifest')).toBe('snapshots/s1/manifest.json');
    expect(expectedControlKey('s1', 'layout')).toBe('snapshots/s1/layout.json');
    expect(expectedControlKey('s1', 'system_state_manifest')).toBe('snapshots/s1/system-state/manifest.json');
  });
});
