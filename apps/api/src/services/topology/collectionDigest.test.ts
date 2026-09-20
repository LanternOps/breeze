import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import vectors from '../../../../../packages/shared/src/testing/topology-vectors.json';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { networkContextFullSchema } from '@breeze/shared';
import {
  normalizeNetworkContext,
  topologyContextDigest,
  topologySectionDigest,
} from './collectionDigest';
import { sourceKey, type AuthenticatedTopologyProducer } from './collectionTypes';

// M1 Task 7 — packages/shared/src/validators/topologyCollectionCanonical.test.ts
// already proves canonicalizeTopologyContext/canonicalizeTopologySection ignore
// timestamps/set ordering and change on completeness/context/missing rows; that
// coverage is not duplicated here. This file covers what was actually missing:
// the API-side SHA-256 wrappers agree with the checked-in cross-language
// vectors, and normalizeNetworkContext's admission logic (epoch fencing, digest
// mismatch detection, full vs. unchanged shaping) — none of which had a unit
// test; only the DB-backed integration suite touched it indirectly.
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const producer: AuthenticatedTopologyProducer = {
  scope: { orgId: 'org-1', siteId: 'site-1' },
  producerId: 'device-1',
  producerKind: 'agent',
  producerEpoch: 'fixture-epoch-1',
  configurationRevision: '1',
  sourceIdentity: 'fixture-agent',
};

describe('topologyContextDigest / topologySectionDigest', () => {
  it('agree with the checked-in cross-language vectors', () => {
    for (const vector of vectors.vectors) {
      const report = networkContextFullSchema.parse(vector.report);
      expect(topologyContextDigest(report, vector.sourceIdentity)).toBe(vector.sha256);
      for (const section of report.sections) {
        const fixture = vector.sections.find((s) => s.kind === section.kind)!;
        expect(topologySectionDigest(report, section, vector.sourceIdentity)).toBe(fixture.sha256);
      }
    }
  });

  it('the fixture report already carries its own correct digests', () => {
    const report = networkContextFixture();
    expect(topologyContextDigest(report, producer.sourceIdentity)).toBe(report.contentDigest);
    for (const section of report.sections) {
      expect(topologySectionDigest(report, section, producer.sourceIdentity)).toBe(section.contentDigest);
    }
  });

  it('ignores timestamp/sequence metadata and set ordering (same digest), but changes on a missing row', () => {
    const a = networkContextFixture();
    const b = networkContextFixture();
    b.sections.reverse();
    b.sequence = '2';
    b.capturedAt = '2026-09-15T12:05:00Z';
    // contentDigest itself is excluded from canonicalization input, so
    // rewriting it must not change the recomputed digest either.
    b.contentDigest = 'f'.repeat(64);
    const digestA = topologyContextDigest(a, producer.sourceIdentity);
    expect(topologyContextDigest(b, producer.sourceIdentity)).toBe(digestA);

    // Dropping a row (simulating a missing observation) must change the digest.
    const c = networkContextFixture();
    const interfaces = c.sections.find((s) => s.kind === 'interfaces')!;
    interfaces.rows = [];
    interfaces.rowCount = 0;
    expect(topologyContextDigest(c, producer.sourceIdentity)).not.toBe(digestA);
  });

  it('changes when a section outcome/completeness flips', () => {
    const a = networkContextFixture();
    const b = networkContextFixture();
    b.sections[0]!.outcome = 'partial';
    expect(topologyContextDigest(b, producer.sourceIdentity)).not.toBe(topologyContextDigest(a, producer.sourceIdentity));
  });

  it('changes when the context manifest (context coverage) changes', () => {
    const a = networkContextFixture();
    const b = networkContextFixture();
    b.contextManifest = { outcome: 'partial', contexts: b.contextManifest.contexts };
    expect(topologyContextDigest(b, producer.sourceIdentity)).not.toBe(topologyContextDigest(a, producer.sourceIdentity));
  });
});

describe('normalizeNetworkContext', () => {
  it('rejects a report whose producer epoch does not match the authenticated producer', () => {
    const report = networkContextFixture();
    expect(() => normalizeNetworkContext(producer, { ...report, producerEpoch: 'different-epoch' }))
      .toThrow('producer_epoch_changed');
  });

  it('rejects a full report whose contentDigest does not match its recomputed canonical digest', () => {
    const report = networkContextFixture();
    expect(() => normalizeNetworkContext(producer, { ...report, contentDigest: '0'.repeat(64) }))
      .toThrow('content_digest_mismatch');
  });

  it('rejects a full report whose section contentDigest does not match', () => {
    const report = networkContextFixture();
    const tampered = { ...report, sections: report.sections.map((s, i) => (i === 0 ? { ...s, contentDigest: '0'.repeat(64) } : s)) };
    expect(() => normalizeNetworkContext(producer, tampered)).toThrow('section_digest_mismatch');
  });

  it('normalizes a valid full report into one snapshot per section, keyed by protocol/contextKey/addressFamily', () => {
    const report = networkContextFixture();
    const normalized = normalizeNetworkContext(producer, report);
    expect(normalized).toHaveLength(report.sections.length);
    for (const [i, entry] of normalized.entries()) {
      expect(entry.reportKind).toBe('full');
      if (entry.reportKind !== 'full') throw new Error('unreachable');
      const section = report.sections[i]!;
      expect(entry.snapshot.key).toEqual(sourceKey(section));
      expect(entry.snapshot.snapshotId).toBe(report.snapshotId);
      expect(entry.snapshot.sequence).toBe(report.sequence);
      expect(entry.snapshot.contentDigest).toBe(section.contentDigest);
      expect(entry.snapshot.section).toEqual(section);
    }
  });

  it('shapes an unchanged report as a single confirmation keyed to the envelope root', () => {
    const unchanged = {
      version: 1 as const,
      producerEpoch: producer.producerEpoch,
      snapshotId: '10000000-0000-4000-8000-000000000008',
      sequence: '2',
      capturedAt: '2026-09-15T12:05:00Z',
      captureAgeAtSendMs: 0,
      expectedIntervalSeconds: 300,
      contentDigest: '6a9fae86bed2576055be3c1f08be15854e952ad301b3e426b374a6f7b0be640b',
      reportKind: 'unchanged' as const,
      baseSnapshotId: '10000000-0000-4000-8000-000000000008',
    };
    const normalized = normalizeNetworkContext(producer, unchanged);
    expect(normalized).toEqual([{
      reportKind: 'unchanged',
      confirmation: { ...unchanged, key: { protocol: 'envelope', contextKey: 'root', addressFamily: 'any' } },
    }]);
  });
});
