import { describe, it, expect } from 'vitest';
import { applyDlp, DLP_MAX_CELL_CHARS } from './clientAiDlp';

const ORG = '0a1b2c3d-1111-4222-8333-444455556666';
const RULE_ID = '0b8f8f54-1111-4222-8333-444455556666';

const VISA = '4111111111111111'; // Luhn-valid test number
const VISA_SPACED = '4111 1111 1111 1111';
const IBAN = 'DE89370400440532013000'; // mod-97 valid
const SK_KEY = 'sk-ant-abcdefghijklmnop1234';

describe('applyDlp — config handling', () => {
  it('treats {} as the documented defaults (financial redact, email/phone off)', async () => {
    const r = await applyDlp({
      text: `card ${VISA} mail alice@example.com`,
      dlpConfig: {},
      orgId: ORG,
    });
    expect(r.action).toBe('allow');
    expect(r.text).toContain('[REDACTED:creditCard]');
    expect(r.text).toContain('alice@example.com'); // email off by default
    expect(r.redactions).toEqual([{ rule: 'creditCard', count: 1, location: 'text' }]);
  });

  it('degrades an invalid stored config to defaults (never to off)', async () => {
    const r = await applyDlp({
      text: `card ${VISA}`,
      dlpConfig: { creditCards: 'nope' }, // strict-parse failure
      orgId: ORG,
    });
    expect(r.text).toContain('[REDACTED:creditCard]');
  });

  it('passes clean payloads through untouched', async () => {
    const r = await applyDlp({ text: 'sum column B please', dlpConfig: {}, orgId: ORG });
    expect(r).toEqual({ action: 'allow', text: 'sum column B please', redactions: [] });
  });

  it('handles empty input (no text, no cells)', async () => {
    const r = await applyDlp({ dlpConfig: {}, orgId: ORG });
    expect(r).toEqual({ action: 'allow', redactions: [] });
  });
});

describe('applyDlp — action precedence (block > redact > log)', () => {
  it('any block-rule match blocks the whole payload with no partial results', async () => {
    const r = await applyDlp({
      text: `${VISA} and ${IBAN}`,
      dlpConfig: { builtins: { iban: 'block' } },
      orgId: ORG,
    });
    expect(r.action).toBe('block');
    expect(r.blockReason).toBe('dlp_blocked:iban');
    expect(r.text).toBeUndefined();
    expect(r.cells).toBeUndefined();
    // value-free events still recorded for the MSP audit view
    expect(r.redactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'iban', count: 1 }),
        expect.objectContaining({ rule: 'creditCard', count: 1 }),
      ]),
    );
  });

  it('a custom block rule wins over builtin redacts', async () => {
    const r = await applyDlp({
      text: `${VISA} PROJECT-AURORA`,
      dlpConfig: {
        customRules: [
          { id: RULE_ID, name: 'Codename', pattern: 'PROJECT-[A-Z]+', action: 'block' },
        ],
      },
      orgId: ORG,
    });
    expect(r.action).toBe('block');
    expect(r.blockReason).toBe('dlp_blocked:Codename');
  });

  it('log rules record events without modifying content', async () => {
    const r = await applyDlp({
      text: 'mail alice@example.com',
      dlpConfig: { builtins: { email: 'log' } },
      orgId: ORG,
    });
    expect(r.action).toBe('allow');
    expect(r.text).toBe('mail alice@example.com');
    expect(r.redactions).toEqual([{ rule: 'email', count: 1, location: 'text' }]);
  });

  it('custom redact rules replace with [REDACTED:<name>]', async () => {
    const r = await applyDlp({
      text: 'badge EMP-123456 active',
      dlpConfig: {
        customRules: [{ id: RULE_ID, name: 'Employee ID', pattern: 'EMP-\\d{6}', action: 'redact' }],
      },
      orgId: ORG,
    });
    expect(r.text).toBe('badge [REDACTED:Employee ID] active');
    expect(r.redactions).toEqual([{ rule: 'Employee ID', count: 1, location: 'text' }]);
  });

  it('overlapping redact spans merge into a single token', async () => {
    const r = await applyDlp({
      text: VISA,
      dlpConfig: {
        customRules: [{ id: RULE_ID, name: 'quad', pattern: '\\d{4}', action: 'redact' }],
      },
      orgId: ORG,
    });
    // creditCard span [0,16) and the custom quads merge into one token
    expect(r.text).toMatch(/^\[REDACTED:[^\]]+\]$/);
  });
});

describe('applyDlp — cell matrices', () => {
  it('redacts within cells, preserves untouched cells and their types', async () => {
    const cells = [
      ['Name', 'Card', 'Balance'],
      ['Alice', VISA_SPACED, 1200.5],
      ['Bob', `note ${VISA} end`, true],
    ];
    const r = await applyDlp({ cells, dlpConfig: {}, orgId: ORG });
    expect(r.action).toBe('allow');
    expect(r.cells![0]).toEqual(['Name', 'Card', 'Balance']);
    expect(r.cells![1]![1]).toBe('[REDACTED:creditCard]');
    expect(r.cells![1]![2]).toBe(1200.5);
    expect(r.cells![2]![1]).toBe('note [REDACTED:creditCard] end');
    expect(r.cells![2]![2]).toBe(true);
    expect(r.redactions).toEqual([
      { rule: 'creditCard', count: 2, location: 'cell[1][1] (+1 more)' },
    ]);
  });

  it('stringifies numeric cells before scanning (Excel stores card numbers as numbers)', async () => {
    const r = await applyDlp({ cells: [[4111111111111111]], dlpConfig: {}, orgId: ORG });
    expect(r.cells![0]![0]).toBe('[REDACTED:creditCard]');
  });

  it('leaves null/undefined/empty cells alone', async () => {
    const r = await applyDlp({ cells: [[null, undefined, '']], dlpConfig: {}, orgId: ORG });
    expect(r.cells).toEqual([[null, undefined, '']]);
    expect(r.redactions).toEqual([]);
  });

  it('does not mutate the input matrix', async () => {
    const cells = [[VISA]];
    await applyDlp({ cells, dlpConfig: {}, orgId: ORG });
    expect(cells[0]![0]).toBe(VISA);
  });

  it('activates bare-SSN matching from a header cell elsewhere in the payload', async () => {
    const withHeader = await applyDlp({ cells: [['SSN'], ['536221234']], dlpConfig: {}, orgId: ORG });
    expect(withHeader.cells![1]![0]).toBe('[REDACTED:ssn]');

    const noContext = await applyDlp({ cells: [['ID'], ['536221234']], dlpConfig: {}, orgId: ORG });
    expect(noContext.cells![1]![0]).toBe('536221234');
  });

  it('dashed SSNs in cells redact without any context', async () => {
    const r = await applyDlp({ cells: [['536-22-1234']], dlpConfig: {}, orgId: ORG });
    expect(r.cells![0]![0]).toBe('[REDACTED:ssn]');
  });

  it('scans text and cells in the same call', async () => {
    const r = await applyDlp({ text: `IBAN ${IBAN}`, cells: [[VISA]], dlpConfig: {}, orgId: ORG });
    expect(r.text).toBe('IBAN [REDACTED:iban]');
    expect(r.cells![0]![0]).toBe('[REDACTED:creditCard]');
  });
});

describe('applyDlp — redaction event accuracy', () => {
  it('reports rule, total count, and first location with overflow note', async () => {
    const r = await applyDlp({
      text: VISA,
      cells: [[VISA, `${VISA} ${VISA}`]],
      dlpConfig: {},
      orgId: ORG,
    });
    expect(r.redactions).toEqual([{ rule: 'creditCard', count: 4, location: 'text (+2 more)' }]);
  });
});

describe('applyDlp — size caps (fail closed)', () => {
  it('blocks when cell count exceeds DLP_MAX_CELLS', async () => {
    const rows = Array.from({ length: 501 }, () => new Array(100).fill('x')); // 50,100 cells
    const r = await applyDlp({ cells: rows, dlpConfig: {}, orgId: ORG });
    expect(r).toEqual({
      action: 'block',
      blockReason: 'payload_too_large_for_dlp',
      redactions: [],
    });
  });

  it('blocks when a single cell exceeds the per-cell char cap', async () => {
    const r = await applyDlp({
      cells: [['a'.repeat(DLP_MAX_CELL_CHARS + 1)]],
      dlpConfig: {},
      orgId: ORG,
    });
    expect(r.action).toBe('block');
    expect(r.blockReason).toBe('payload_too_large_for_dlp');
  });
});

describe('applyDlp — idempotency', () => {
  it('re-scanning redacted output produces no new findings', async () => {
    const first = await applyDlp({
      text: `card ${VISA}, ssn 536-22-1234, iban ${IBAN}, key ${SK_KEY}, brz_${'ab12'.repeat(12)}`,
      dlpConfig: {},
      orgId: ORG,
    });
    expect(first.action).toBe('allow');
    expect(first.redactions.length).toBeGreaterThan(0);

    const second = await applyDlp({ text: first.text!, dlpConfig: {}, orgId: ORG });
    expect(second.redactions).toEqual([]);
    expect(second.text).toBe(first.text);
  });
});

describe('applyDlp — redact-before-log contract (spec §6)', () => {
  it('the persisted form (result.text) never contains the raw sensitive values', async () => {
    const raw = `Card ${VISA_SPACED}, key ${SK_KEY}, acct ${IBAN}`;
    const result = await applyDlp({ text: raw, dlpConfig: {}, orgId: ORG });

    // Plan 2's persistence path MUST store result.text + result.redactions —
    // never input.text. This is the unit-level proof; the integration
    // assertion lives in Plan 2's session-route test (the ai_messages insert
    // mock receives result.text).
    expect(result.action).toBe('allow');
    expect(result.text).not.toContain(VISA_SPACED);
    expect(result.text).not.toContain(SK_KEY);
    expect(result.text).not.toContain(IBAN);
    expect(result.text).toContain('[REDACTED:creditCard]');
    expect(result.text).toContain('[REDACTED:apiKey]');
    expect(result.text).toContain('[REDACTED:iban]');

    // The events persisted alongside are value-free: rule/count/location only.
    for (const event of result.redactions) {
      expect(Object.keys(event).sort()).toEqual(['count', 'location', 'rule']);
    }

    // And storing the redacted form is stable: re-scanning it finds nothing.
    const second = await applyDlp({ text: result.text!, dlpConfig: {}, orgId: ORG });
    expect(second.redactions).toEqual([]);
    expect(second.text).toBe(result.text);
  });
});
