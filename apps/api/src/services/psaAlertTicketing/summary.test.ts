import { describe, expect, it } from 'vitest';
import { buildTicketDescription, buildTicketSummary, PSA_TICKET_DESCRIPTION_MAX_MESSAGE } from './summary';

const ALERT_ID = '0f8a2b3c-1d2e-4f50-8a6b-7c8d9e0f1a2b';

describe('buildTicketSummary', () => {
  it('is [SEV] title — hostname', () => {
    expect(buildTicketSummary({ severity: 'critical', title: 'Disk full', hostname: 'HOST01' }, { maxCodePoints: 100 }))
      .toBe('[CRITICAL] Disk full — HOST01');
  });

  it('has no trailing separator for an alert without a device (Review 1)', () => {
    expect(buildTicketSummary({ severity: 'medium', title: 'Switch port down', hostname: null }, { maxCodePoints: 100 }))
      .toBe('[MEDIUM] Switch port down');
    expect(buildTicketSummary({ severity: 'medium', title: 'Switch port down', hostname: '   ' }, { maxCodePoints: 100 }))
      .toBe('[MEDIUM] Switch port down');
  });

  it('collapses whitespace and strips control characters to one line', () => {
    expect(buildTicketSummary({ severity: 'high', title: 'CPU\n\thigh\u0007 ', hostname: 'H\r\n1' }, { maxCodePoints: 100 }))
      .toBe('[HIGH] CPU high — H 1');
  });

  it('cuts a long emoji title by code point, never leaving a lone surrogate, ending with … (Review 3)', () => {
    const title = '🔥'.repeat(300);
    const summary = buildTicketSummary({ severity: 'critical', title, hostname: 'HOST01' }, { maxCodePoints: 100 });
    const codePoints = Array.from(summary);
    expect(codePoints.length).toBe(100);
    expect(summary.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(summary)).toBe(false);
    expect(summary.startsWith('[CRITICAL] 🔥')).toBe(true);
  });

  it('keeps a required marker suffix intact and truncates the text before it', () => {
    const suffix = ' [breeze-alert:0f8a2b3c]';
    const summary = buildTicketSummary(
      { severity: 'low', title: 'x'.repeat(200), hostname: 'HOST01' },
      { maxCodePoints: 60, suffix },
    );
    expect(Array.from(summary).length).toBe(60);
    expect(summary.endsWith(`…${suffix}`)).toBe(true);
  });

  it('does not truncate a summary that fits exactly', () => {
    const title = 'a'.repeat(100 - '[LOW] '.length);
    expect(buildTicketSummary({ severity: 'low', title, hostname: null }, { maxCodePoints: 100 })).toBe(`[LOW] ${title}`);
  });

  it('rejects a limit too small to hold the suffix and an ellipsis', () => {
    expect(() => buildTicketSummary({ severity: 'low', title: 't', hostname: null }, { maxCodePoints: 5, suffix: ' [breeze-alert:0f8a2b3c]' }))
      .toThrow();
  });
});

describe('buildTicketDescription', () => {
  const base = {
    alertId: ALERT_ID,
    severity: 'critical',
    title: 'Disk full',
    message: 'C: is 99% full',
    deviceHostname: 'HOST01',
    siteName: 'Main office',
    orgName: 'Example Org',
    alertUrl: `https://rmm.example.test/alerts/${ALERT_ID}`,
    triggeredAt: '2026-10-30T10:00:00.000Z',
  };

  it('carries the message, device, site, org, link and a marker line', () => {
    const text = buildTicketDescription(base);
    expect(text).toContain('C: is 99% full');
    expect(text).toContain('Device: HOST01');
    expect(text).toContain('Site: Main office');
    expect(text).toContain('Organization: Example Org');
    expect(text).toContain(`Alert: https://rmm.example.test/alerts/${ALERT_ID}`);
    expect(text).toContain('Triggered: 2026-10-30T10:00:00.000Z');
    expect(text.trimEnd().split('\n').at(-1)).toBe(`Breeze alert reference: breeze-alert:${ALERT_ID}`);
  });

  it('omits lines for missing device, site and message', () => {
    const text = buildTicketDescription({ ...base, deviceHostname: null, siteName: null, message: null });
    expect(text).not.toContain('Device:');
    expect(text).not.toContain('Site:');
    expect(text.startsWith('Severity: CRITICAL')).toBe(true);
  });

  it('caps a very long message by code point', () => {
    const text = buildTicketDescription({ ...base, message: '😀'.repeat(PSA_TICKET_DESCRIPTION_MAX_MESSAGE + 50) });
    const messageLine = text.split('\n')[0]!;
    expect(Array.from(messageLine).length).toBe(PSA_TICKET_DESCRIPTION_MAX_MESSAGE);
    expect(messageLine.endsWith('…')).toBe(true);
  });
});
