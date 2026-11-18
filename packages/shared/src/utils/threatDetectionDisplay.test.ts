import { describe, expect, it } from 'vitest';
import {
  clientDetectionAdvice,
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

describe('length cap before the email scrub (#12046 follow-up)', () => {
  it('caps a very long title, quickly, instead of running the address pattern over all of it', () => {
    // One 200k-character token with no address in it: the address pattern
    // retries from every start position, so an uncapped scrub is quadratic.
    const started = Date.now();
    const title = clientDetectionTitle(`Detection ${'x'.repeat(200_000)}`, 'Acme');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(title.length).toBeLessThanOrEqual(303);
  });

  it('never leaves half an address behind when the cap cuts through one', () => {
    // 291 characters of words, then an address across the 300-character cap.
    const raw = `${'Sign-in '.repeat(36)}xx jane.doe@example.com and more text after it`;
    expect(raw.indexOf('jane.doe@')).toBe(291);
    expect(raw.indexOf('example.com') + 'example.com'.length).toBeGreaterThan(300);
    const title = clientDetectionTitle(raw, 'Acme');
    expect(title).not.toMatch(/jane|@|example/);
    expect(title.endsWith('...')).toBe(true);
  });

  it('falls back to "Detection", not a bare ellipsis, when the title is one huge word', () => {
    expect(clientDetectionTitle('x'.repeat(5_000), 'Acme')).toBe('Detection');
    expect(clientDetectionAdvice('y'.repeat(5_000))).toBe('');
  });

  it('keeps a word that ends exactly at the cap, and scrubs an address that does', () => {
    const word = `${'abcd '.repeat(59)}wxyz`; // 299 characters, last word ends at the cap
    // A space at index 299 (just before the cap) and at 300 (the cap) both keep the word.
    expect(clientDetectionTitle(`${word} more`, 'Acme')).toBe(`${word}...`);
    expect(clientDetectionTitle(`${word}z more`, 'Acme')).toBe(`${word}z...`);
    // A word that crosses the cap is dropped whole.
    expect(clientDetectionTitle(`${word}zz more`, 'Acme')).toBe(`${'abcd '.repeat(59).trimEnd()}...`);
    const addr = `${'abcd '.repeat(56)}jane.doe@example.com`; // 300 characters, address ends at the cap
    expect(addr.length).toBe(300);
    expect(clientDetectionTitle(`${addr} more`, 'Acme')).toBe(`${'abcd '.repeat(56)}a user account...`);
  });

  it('still drops the trailing org name from a title longer than the cap', () => {
    // "(Acme Corp)" runs from 295 to 306, across the cap: cutting first would
    // leave "(Acme..." behind.
    const raw = `Detection ${'word '.repeat(57)}(Acme Corp)`;
    expect(raw.indexOf('(Acme')).toBe(295);
    const title = clientDetectionTitle(raw, 'Acme Corp');
    expect(title).not.toMatch(/Acme/);
    expect(title).toBe(`Detection ${'word '.repeat(57).trimEnd()}`);
  });

  it('leaves a title under the cap untouched apart from the usual rewrites', () => {
    const raw = `Suspicious sign-in ${'a'.repeat(250)}`;
    expect(clientDetectionTitle(raw, 'Acme')).toBe(raw);
  });
});

describe('clientDetectionAdvice (#12046 follow-up)', () => {
  it('replaces an email address in the advice with a neutral phrase', () => {
    expect(clientDetectionAdvice('Reset the password for jane.doe@example.com and review sign-ins.'))
      .toBe('Reset the password for a user account and review sign-ins.');
  });

  it('keeps advice without an address as written', () => {
    expect(clientDetectionAdvice('Isolate the host and reimage.')).toBe('Isolate the host and reimage.');
  });

  it('returns an empty string for absent advice, so the cell stays blank', () => {
    expect(clientDetectionAdvice(null)).toBe('');
    expect(clientDetectionAdvice('   ')).toBe('');
  });

  it('caps very long advice without leaving half an address', () => {
    // The address runs from character 986 to 1006, across the 1000 cap.
    const raw = `${'Review the account. '.repeat(49)}Reset jane.doe@example.com`;
    expect(raw.indexOf('jane.doe@')).toBe(986);
    const started = Date.now();
    const advice = clientDetectionAdvice(`${raw}${'y'.repeat(200_000)}`);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(advice.length).toBeLessThanOrEqual(1_003);
    expect(advice).not.toMatch(/jane|@/);
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
