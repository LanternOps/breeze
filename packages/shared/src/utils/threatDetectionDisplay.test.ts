import { describe, expect, it } from 'vitest';
import {
  clientDetectionTitle,
  endpointCoverageCounts,
  openForDays,
  threatSeverityLabel,
  threatStatusLabel,
} from './threatDetectionDisplay';

describe('threatStatusLabel (#12046)', () => {
  it.each([
    ['sent', 'Open'],
    ['open', 'Open'],
    ['new', 'Open'],
    ['in_progress', 'Being investigated'],
    ['auto_remediating', 'Being remediated'],
    ['resolved', 'Resolved'],
    ['closed', 'Resolved'],
    ['dismissed', 'Dismissed'],
  ])('maps the stored status %s to %s', (raw, label) => {
    expect(threatStatusLabel(raw)).toBe(label);
  });

  it('humanizes an unrecognised status instead of printing a raw token', () => {
    expect(threatStatusLabel('pending_review')).toBe('Pending review');
  });

  it('names an absent status rather than printing nothing', () => {
    expect(threatStatusLabel(null)).toBe('Unknown');
    expect(threatStatusLabel('  ')).toBe('Unknown');
  });
});

describe('threatSeverityLabel (#12046)', () => {
  it('capitalises the stored lowercase severity', () => {
    expect(threatSeverityLabel('low')).toBe('Low');
    expect(threatSeverityLabel('CRITICAL')).toBe('Critical');
  });

  it('names an absent severity', () => {
    expect(threatSeverityLabel(null)).toBe('Unknown');
  });
});

describe('clientDetectionTitle (#12046)', () => {
  it('drops the severity prefix and the trailing organization name the vendor adds', () => {
    expect(clientDetectionTitle('LOW - Incident on HOST-1 (Harlow & Pierce P.C.)', 'Harlow & Pierce P.C.'))
      .toBe('Incident on HOST-1');
  });

  it('keeps a trailing parenthetical that is not the organization name', () => {
    expect(clientDetectionTitle('Malware quarantined (Defender)', 'Acme')).toBe('Malware quarantined (Defender)');
  });

  it('replaces an email address with a neutral phrase', () => {
    const title = clientDetectionTitle('HIGH - Suspicious sign-in for jane.doe@example.com (Acme)', 'Acme');
    expect(title).not.toMatch(/@/);
    expect(title).toBe('Suspicious sign-in for a user account');
  });

  it.each([
    'High-risk sign-in from a new country',
    'Low-privilege account created',
    'Info-stealer detected',
    'Critical:process tampering',
  ])('leaves a title that only starts with a severity-like word intact: %s', (title) => {
    expect(clientDetectionTitle(title, 'Acme')).toBe(title);
  });

  it('strips the colon form of the prefix too', () => {
    expect(clientDetectionTitle('CRITICAL: Ransomware behaviour', 'Acme')).toBe('Ransomware behaviour');
  });

  it('falls back to a word when the title is empty or only a prefix', () => {
    expect(clientDetectionTitle(null, 'Acme')).toBe('Detection');
    expect(clientDetectionTitle('MEDIUM - ', 'Acme')).toBe('Detection');
  });
});

describe('openForDays (#12046)', () => {
  it('counts whole days from report to the as-of instant', () => {
    expect(openForDays('2025-04-12T00:00:00.000Z', '2026-11-09T12:00:00.000Z')).toBe(576);
  });

  it('returns null when either instant is missing or unparseable', () => {
    expect(openForDays('2026-01-01T00:00:00.000Z', undefined)).toBeNull();
    expect(openForDays('', '2026-01-01T00:00:00.000Z')).toBeNull();
    expect(openForDays('not a date', '2026-01-01T00:00:00.000Z')).toBeNull();
  });

  it('never reports a negative age for clock skew', () => {
    expect(openForDays('2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(0);
  });
});

describe('endpointCoverageCounts (#12046)', () => {
  it('reconciles: managed = with + without, on a current snapshot', () => {
    const c = endpointCoverageCounts({
      huntressAgents: 8,
      breezeDevices: 12,
      agentsOffline: 0,
      devicesWithoutAgent: 8,
      devicesWithDetectionAgent: 7,
      devicesWithoutDetectionAgent: 5,
      unmatchedAgents: 4,
    });
    expect(c).toEqual({ managed: 12, withAgent: 7, withoutAgent: 5, agentsReported: 8, unmatchedAgents: 4 });
  });

  it('derives a reconciling pair from a legacy snapshot that predates the fields', () => {
    const c = endpointCoverageCounts({ huntressAgents: 8, breezeDevices: 12, agentsOffline: 0, devicesWithoutAgent: 8 });
    expect(c.managed).toBe(12);
    expect(c.withAgent).toBe(4);
    expect(c.withoutAgent).toBe(8);
    // Unknowable on a legacy snapshot (an agent can share a device): not guessed.
    expect(c.unmatchedAgents).toBeNull();
    expect(c.agentsReported).toBe(8);
  });

  it('keeps unmeasured counts null, never zero', () => {
    const c = endpointCoverageCounts({ huntressAgents: null, breezeDevices: 12, agentsOffline: null, devicesWithoutAgent: null });
    expect(c).toEqual({ managed: 12, withAgent: null, withoutAgent: null, agentsReported: null, unmatchedAgents: null });
    expect(endpointCoverageCounts(undefined)).toEqual({
      managed: null, withAgent: null, withoutAgent: null, agentsReported: null, unmatchedAgents: null,
    });
  });
});
