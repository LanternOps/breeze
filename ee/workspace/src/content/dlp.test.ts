import { describe, it, expect } from 'vitest';
import { applyDlpToText } from './dlp';
import { DEFAULT_DLP_CONFIG, type DlpConfig } from '../services/orgSettingsService';

describe('applyDlpToText', () => {
  // ── credit_card ────────────────────────────────────────────────────────────
  it('redacts a Luhn-valid card number and records the finding', () => {
    const r = applyDlpToText('card 4111 1111 1111 1111 ok', DEFAULT_DLP_CONFIG);
    expect(r.text).toBe('card [REDACTED:credit_card] ok');
    expect(r.findings).toEqual([{ detector: 'credit_card', action: 'redact', count: 1 }]);
    expect(r.blocked).toBe(false);
  });

  it('does not flag a Luhn-invalid 16-digit number', () => {
    const r = applyDlpToText('card 4111 1111 1111 1112 ok', DEFAULT_DLP_CONFIG);
    expect(r.text).toBe('card 4111 1111 1111 1112 ok');
    expect(r.findings).toEqual([]);
    expect(r.blocked).toBe(false);
  });

  // ── ssn ────────────────────────────────────────────────────────────────────
  it('redacts a plausible dashed SSN', () => {
    const r = applyDlpToText('ssn 536-90-4399 on file', DEFAULT_DLP_CONFIG);
    expect(r.text).toBe('ssn [REDACTED:ssn] on file');
    expect(r.findings).toEqual([{ detector: 'ssn', action: 'redact', count: 1 }]);
  });

  it('excludes SSNs in invalid ranges (area 000)', () => {
    const r = applyDlpToText('ssn 000-12-3456 nah', DEFAULT_DLP_CONFIG);
    expect(r.text).toBe('ssn 000-12-3456 nah');
    expect(r.findings).toEqual([]);
  });

  it('block action blocks the whole text', () => {
    const cfg: DlpConfig = {
      ...DEFAULT_DLP_CONFIG,
      detectors: { ...DEFAULT_DLP_CONFIG.detectors, ssn: 'block' as const },
    };
    expect(applyDlpToText('ssn 536-90-4399', cfg).blocked).toBe(true);
  });

  it('block short-circuits redaction but the findings list is still complete', () => {
    const cfg: DlpConfig = {
      ...DEFAULT_DLP_CONFIG,
      detectors: { ...DEFAULT_DLP_CONFIG.detectors, ssn: 'block' as const },
    };
    const r = applyDlpToText('card 4111 1111 1111 1111 and ssn 536-90-4399', cfg);
    expect(r.blocked).toBe(true);
    expect(r.findings).toEqual(
      expect.arrayContaining([
        { detector: 'credit_card', action: 'redact', count: 1 },
        { detector: 'ssn', action: 'block', count: 1 },
      ]),
    );
    expect(r.findings).toHaveLength(2);
  });

  // ── iban ───────────────────────────────────────────────────────────────────
  it('redacts a checksum-valid IBAN', () => {
    const r = applyDlpToText('iban DE89370400440532013000 ok', DEFAULT_DLP_CONFIG);
    expect(r.text).toBe('iban [REDACTED:iban] ok');
    expect(r.findings).toEqual([{ detector: 'iban', action: 'redact', count: 1 }]);
  });

  it('does not flag an IBAN-shaped string that fails the mod-97 checksum', () => {
    const r = applyDlpToText('iban DE89370400440532013001 ok', DEFAULT_DLP_CONFIG);
    expect(r.text).toBe('iban DE89370400440532013001 ok');
    expect(r.findings).toEqual([]);
  });

  // ── api_key ────────────────────────────────────────────────────────────────
  it('redacts an entropy-prefixed API key', () => {
    const r = applyDlpToText('key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX1234 leaked', DEFAULT_DLP_CONFIG);
    expect(r.text).toBe('key [REDACTED:api_key] leaked');
    expect(r.findings).toEqual([{ detector: 'api_key', action: 'redact', count: 1 }]);
  });

  // ── email / phone (off by default) ────────────────────────────────────────
  it('off action neither changes text nor records a finding', () => {
    const r = applyDlpToText('reach jane.doe@example.com anytime', DEFAULT_DLP_CONFIG);
    expect(r.text).toBe('reach jane.doe@example.com anytime');
    expect(r.findings).toEqual([]);
    expect(r.blocked).toBe(false);
  });

  it('log action leaves text unchanged but records the finding', () => {
    const cfg: DlpConfig = {
      ...DEFAULT_DLP_CONFIG,
      detectors: { ...DEFAULT_DLP_CONFIG.detectors, email: 'log' as const },
    };
    const r = applyDlpToText('reach jane.doe@example.com anytime', cfg);
    expect(r.text).toBe('reach jane.doe@example.com anytime');
    expect(r.findings).toEqual([{ detector: 'email', action: 'log', count: 1 }]);
    expect(r.blocked).toBe(false);
  });

  it('redacts an E.164-ish phone number when enabled', () => {
    const cfg: DlpConfig = {
      ...DEFAULT_DLP_CONFIG,
      detectors: { ...DEFAULT_DLP_CONFIG.detectors, phone: 'redact' as const },
    };
    const r = applyDlpToText('call +1 415-555-2671 now', cfg);
    expect(r.text).toBe('call [REDACTED:phone] now');
    expect(r.findings).toEqual([{ detector: 'phone', action: 'redact', count: 1 }]);
  });

  // ── custom patterns ───────────────────────────────────────────────────────
  it('custom pattern with named action applies', () => {
    const cfg: DlpConfig = {
      ...DEFAULT_DLP_CONFIG,
      customPatterns: [{ name: 'ticket_id', pattern: 'TICKET-\\d+', action: 'redact' }],
    };
    const r = applyDlpToText('see TICKET-4821 for details', cfg);
    expect(r.text).toBe('see [REDACTED:ticket_id] for details');
    expect(r.findings).toEqual([{ detector: 'ticket_id', action: 'redact', count: 1 }]);
  });

  // ── invariant: idempotence ────────────────────────────────────────────────
  it('is idempotent: re-scanning redacted output yields zero findings', () => {
    const first = applyDlpToText('card 4111 1111 1111 1111 ssn 536-90-4399', DEFAULT_DLP_CONFIG);
    const second = applyDlpToText(first.text, DEFAULT_DLP_CONFIG);
    expect(second.findings).toEqual([]);
    expect(second.text).toBe(first.text);
    expect(second.blocked).toBe(false);
  });

  it('is idempotent when a dashed SSN redaction token leaves behind an unrelated bare 9-digit number', () => {
    // The dashed SSN triggers redaction with no "ssn"/"social security"
    // keyword elsewhere in the source text, so the bare-digit branch never
    // runs on pass 1 and '123456789' is untouched. The emitted
    // '[REDACTED:ssn]' token must not itself be read as context on a
    // re-scan, or pass 2 would newly (and wrongly) flag '123456789'.
    const first = applyDlpToText('id 536-90-4399 next id 123456789 end', DEFAULT_DLP_CONFIG);
    expect(first.text).toBe('id [REDACTED:ssn] next id 123456789 end');
    expect(first.findings).toEqual([{ detector: 'ssn', action: 'redact', count: 1 }]);

    const second = applyDlpToText(first.text, DEFAULT_DLP_CONFIG);
    expect(second.findings).toEqual([]);
    expect(second.text).toBe(first.text);
    expect(second.blocked).toBe(false);
  });
});
