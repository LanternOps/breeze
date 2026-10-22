import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  escapeYaraText,
  generateIocRules,
  parseIocText,
  validateIoc,
  validateIocBatch,
  YaraIocInputError,
} from './yaraIocImport';
import { buildYaraBundleJson } from './yaraBundle';
import {
  YARA_IOC_MAX_PER_BATCH,
  YARA_IOC_MAX_TEXT_BYTES,
  YARA_IOC_RULE_SOURCE_BUDGET,
  YARA_RULE_NAME_PATTERN,
  type YaraIoc,
} from '../types/yara';

const SHA256_A = 'a'.repeat(64);
const SHA256_B = '0123456789abcdef'.repeat(4);
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('parseIocText', () => {
  it('classifies by shape', () => {
    const lines = [
      '44d88612fea8a8f36de82e1278abb02f',
      '3395856ce81f2b7382dee72602f798b642f14140',
      SHA256_B,
      'C:\\Users\\Public\\evil.exe',
      '/tmp/x.sh',
      '\\\\srv\\share\\a.ps1',
      'HKLM\\Software\\Run\\x',
      '10.0.0.5',
      '2001:db8::1',
      'evil[.]com',
      'payload.dll',
      'malware.exe',
      'cdn.example.org',
      'Global\\MutexName',
    ];
    const { iocs, errors } = parseIocText(lines.join('\n'));
    expect(errors).toEqual([]);
    expect(iocs.map((i) => i.kind)).toEqual([
      'md5', 'sha1', 'sha256', 'filepath', 'filepath', 'filepath', 'string',
      'ip', 'ip', 'domain', 'filename', 'filename', 'domain', 'string',
    ]);
    expect(iocs[9]).toEqual({ kind: 'domain', value: 'evil.com' });
  });

  it('applies a kind prefix only when it names a kind', () => {
    const { iocs, errors } = parseIocText(
      ['filename:invoice.com', `SHA256:${SHA256_A.toUpperCase()}`, 'nope:xxxx', 'C:\\a\\b.exe', '2001:db8::1', 'hxxp://evil[.]com/x'].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(iocs).toEqual([
      { kind: 'filename', value: 'invoice.com' },
      { kind: 'sha256', value: SHA256_A },
      { kind: 'string', value: 'nope:xxxx' },
      { kind: 'filepath', value: 'C:\\a\\b.exe' },
      { kind: 'ip', value: '2001:db8::1' },
      { kind: 'string', value: 'http://evil.com/x' },
    ]);
  });

  it('rejects an unknown kind in JSON input', () => {
    const { iocs, errors } = parseIocText('[{"kind":"nope","value":"evil.com"}]');
    expect(iocs).toEqual([]);
    expect(errors).toEqual([{ line: 1, value: 'evil.com', code: 'unknown_kind' }]);
  });

  it('canonicalises IPv6 before dedupe', () => {
    const { iocs, errors } = parseIocText('2001:0db8:0000::0001\n2001:db8::1\n::ffff:10.0.0.1');
    expect(iocs).toEqual([
      { kind: 'ip', value: '2001:db8::1' },
      { kind: 'ip', value: '::ffff:10.0.0.1' },
    ]);
    expect(errors).toEqual([{ line: 2, value: '2001:db8::1', code: 'duplicate' }]);
  });

  it('rejects malformed IPs with an explicit kind', () => {
    expect(validateIoc({ kind: 'ip', value: '10.0.0.256' })).toEqual({ ok: false, code: 'bad_ip' });
    expect(validateIoc({ kind: 'ip', value: '1::2::3' })).toEqual({ ok: false, code: 'bad_ip' });
    expect(validateIoc({ kind: 'ip', value: 'fe80::1%eth0' })).toEqual({ ok: false, code: 'bad_ip' });
  });

  it('asks for punycode on non-ASCII domains', () => {
    const { iocs, errors } = parseIocText('bücher.de\ndomain:xn--bcher-kva.de');
    expect(errors).toEqual([{ line: 1, value: 'bücher.de', code: 'bad_domain' }]);
    expect(iocs).toEqual([{ kind: 'domain', value: 'xn--bcher-kva.de' }]);
  });

  it('parses JSON arrays of strings and objects', () => {
    expect(parseIocText('["evil.com", {"kind":"string","value":"abcd"}]')).toEqual({
      iocs: [{ kind: 'domain', value: 'evil.com' }, { kind: 'string', value: 'abcd' }],
      errors: [],
    });
    expect(parseIocText('[{"kind":"md5","value":"zz"}]').errors).toEqual([{ line: 1, value: 'zz', code: 'bad_hash' }]);
  });

  it('skips comments and blanks and flags duplicates', () => {
    const { iocs, errors } = parseIocText('# x\n\nEVIL.com\nevil.com');
    expect(iocs).toEqual([{ kind: 'domain', value: 'evil.com' }]);
    expect(errors).toEqual([{ line: 4, value: 'evil.com', code: 'duplicate' }]);
  });

  it('enforces string byte length', () => {
    expect(validateIoc({ kind: 'string', value: 'abc' })).toEqual({ ok: false, code: 'too_short' });
    expect(validateIoc({ kind: 'string', value: 'x'.repeat(257) })).toEqual({ ok: false, code: 'too_long' });
    expect(validateIoc({ kind: 'string', value: '€uro' })).toEqual({ ok: true, ioc: { kind: 'string', value: '€uro' } });
    expect(validateIoc({ kind: 'string', value: '   ' })).toEqual({ ok: false, code: 'empty' });
  });

  it('rejects malformed hashes, paths and filenames', () => {
    expect(validateIoc({ kind: 'sha1', value: SHA256_A })).toEqual({ ok: false, code: 'bad_hash' });
    expect(validateIoc({ kind: 'filepath', value: 'relative\\x.exe' })).toEqual({ ok: false, code: 'bad_path' });
    expect(validateIoc({ kind: 'filename', value: 'dir/x.exe' })).toEqual({ ok: false, code: 'bad_path' });
    expect(validateIoc({ kind: 'nope' as never, value: 'x' })).toEqual({ ok: false, code: 'unknown_kind' });
  });

  it('refuses text over the byte cap', () => {
    const { iocs, errors } = parseIocText('a'.repeat(YARA_IOC_MAX_TEXT_BYTES + 1));
    expect(iocs).toEqual([]);
    expect(errors).toEqual([{ line: 0, value: '', code: 'too_long' }]);
  });
});

describe('validateIocBatch', () => {
  it('reports every bad entry and duplicates by index', () => {
    const res = validateIocBatch([
      { kind: 'md5', value: 'zz' },
      { kind: 'domain', value: 'Evil.com' },
      { kind: 'domain', value: 'evil.com' },
    ]);
    expect(res).toEqual({ ok: false, errors: [{ index: 0, code: 'bad_hash' }, { index: 2, code: 'duplicate' }] });
  });
});

describe('escapeYaraText', () => {
  it('escapes backslash, quote and every byte outside printable ASCII', () => {
    expect(escapeYaraText('a"b\\c\u00e9\n')).toBe('a\\"b\\\\c\\xc3\\xa9\\x0a');
  });
});

describe('generateIocRules', () => {
  const sample: YaraIoc[] = [
    { kind: 'sha256', value: SHA256_B },
    { kind: 'string', value: 'zzzz-marker' },
    { kind: 'filename', value: 'payload.dll' },
    { kind: 'sha256', value: SHA256_A },
    { kind: 'domain', value: 'evil.com' },
    { kind: 'string', value: 'aaaa-marker' },
  ];

  it('generates one rule per kind', () => {
    const rules = generateIocRules({ label: 'ACME Advisory 7', iocs: sample });
    expect(rules.map((r) => r.kind)).toEqual(['sha256', 'filename', 'domain', 'string']);
    for (const r of rules) {
      expect(r.name).toMatch(new RegExp(`^ioc_acme_advisory_7_${r.kind}_[0-9a-f]{16}$`));
      expect(r.source).toContain('source = "breeze-ioc-import"');
      expect(r.source).toContain('label = "ACME Advisory 7"');
      expect(r.source).toContain(`rule ${r.name} : ioc ${r.kind}\n{\n`);
      expect(r.tags).toEqual(['ioc', r.kind]);
      expect(r.severity).toBe('high');
    }
    const [hash, filename, domain, str] = rules;
    expect(hash!.source.startsWith('import "hash"\n\nrule ')).toBe(true);
    // The digest is bound once per rule, not re-computed per literal.
    expect(hash!.source).toContain(
      '  condition:\n    with digest = hash.sha256(0, filesize) : (\n' +
        `      digest == "${SHA256_B}" or\n      digest == "${SHA256_A}"\n    )\n}\n`,
    );
    expect(hash!.source.match(/hash\.sha256\(/g)).toHaveLength(1);
    expect(hash!.iocCount).toBe(2);
    expect(hash!.source).toContain('ioc_count = 2');
    expect(filename!.source).toContain('filename iequals "payload.dll"');
    expect(filename!.source).not.toContain('strings:');
    expect(domain!.source).toContain('$i0 = "evil.com" ascii wide nocase');
    expect(str!.source).toContain('$i0 = "aaaa-marker" ascii wide\n');
    expect(str!.source).toContain('$i1 = "zzzz-marker" ascii wide\n');
    expect(str!.source).not.toContain('nocase');
    expect(str!.source).toContain('  condition:\n    any of them\n}\n');
  });

  it('writes non-ASCII strings as UTF-8 text plus a UTF-16LE hex pattern', () => {
    const [rule] = generateIocRules({ label: 'x', iocs: [{ kind: 'string', value: 'prüfung' }] });
    expect(rule!.source).toContain('$i0 = "pr\\xc3\\xbcfung"\n');
    expect(rule!.source).toContain('$i0w = { 70 00 72 00 fc 00 66 00 75 00 6e 00 67 00 }\n');
  });

  it('is deterministic regardless of input order', () => {
    const a = generateIocRules({ label: 'L', iocs: sample });
    const b = generateIocRules({ label: 'L', iocs: [...sample].reverse() });
    expect(b).toEqual(a);
  });

  it('chunks a kind over the source budget into suffixed rules', () => {
    const iocs: YaraIoc[] = Array.from({ length: 1000 }, (_, i) => ({
      kind: 'string',
      value: `${String(i).padStart(4, '0')}${'q'.repeat(252)}`,
    }));
    const rules = generateIocRules({ label: 'big', iocs: [...iocs].reverse() });
    expect(rules.length).toBeGreaterThanOrEqual(2);
    expect(rules.reduce((n, r) => n + r.iocCount, 0)).toBe(1000);
    expect(rules[0]!.name).toMatch(/^ioc_big_string_[0-9a-f]{16}$/);
    rules.slice(1).forEach((r, i) => expect(r.name).toMatch(new RegExp(`_${i + 2}$`)));
    for (const r of rules) expect(bytes(r.source)).toBeLessThanOrEqual(YARA_IOC_RULE_SOURCE_BUDGET);
    // Sorted across chunks: chunk 1 starts with 0000…, the last chunk ends with 0999….
    expect(rules[0]!.source).toContain('$i0 = "0000');
    expect(rules[rules.length - 1]!.source).toContain('"0999');
  });

  it('keeps names within the identifier rule for a long label', () => {
    const rules = generateIocRules({ label: 'A'.repeat(200), iocs: sample });
    for (const r of rules) {
      expect(r.name.length).toBeLessThanOrEqual(128);
      expect(r.name).toMatch(YARA_RULE_NAME_PATTERN);
      expect(r.name.startsWith(`ioc_${'a'.repeat(64)}_`)).toBe(true);
    }
    expect(generateIocRules({ label: '!!!', iocs: sample })[0]!.name).toMatch(/^ioc_batch_sha256_/);
  });

  it('rejects empty, invalid, duplicate and over-cap batches', () => {
    expect(() => generateIocRules({ label: 'x', iocs: [] })).toThrow(YaraIocInputError);
    expect(() => generateIocRules({ label: 'x', iocs: [{ kind: 'md5', value: 'zz' }] })).toThrow(YaraIocInputError);
    expect(() => generateIocRules({
      label: 'x', iocs: [{ kind: 'domain', value: 'a.io' }, { kind: 'domain', value: 'A.io' }],
    })).toThrow(YaraIocInputError);
    const over = Array.from({ length: YARA_IOC_MAX_PER_BATCH + 1 }, (_, i) => ({
      kind: 'string' as const, value: `marker-${i}`,
    }));
    expect(() => generateIocRules({ label: 'x', iocs: over })).toThrow(YaraIocInputError);
  });

  it('matches the agent golden bundle byte for byte', () => {
    const goldenPath = resolve(__dirname, '../../../../agent/internal/yarascan/testdata/ioc-import.golden.json');
    const rules = generateIocRules({
      label: 'Golden "IOC" set',
      iocs: [
        { kind: 'md5', value: '44d88612fea8a8f36de82e1278abb02f' },
        { kind: 'sha1', value: '3395856ce81f2b7382dee72602f798b642f14140' },
        { kind: 'sha256', value: '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f' },
        { kind: 'filename', value: 'payload.dll' },
        { kind: 'filename', value: 'rëport.exe' },
        { kind: 'filepath', value: 'C:\\Users\\Public\\evil.exe' },
        { kind: 'domain', value: 'evil.example.com' },
        { kind: 'ip', value: '203.0.113.7' },
        { kind: 'string', value: 'breeze_ioc_golden_marker' },
        { kind: 'string', value: 'prüfung' },
        { kind: 'string', value: 'say "hi" \\ bye' },
      ],
    });
    const json = buildYaraBundleJson({
      ruleSetId: '00000000-0000-4000-8000-0000000010c0',
      version: 1,
      autoQuarantine: false,
      rules: rules.map((r, i) => ({
        id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        name: r.name,
        severity: r.severity,
        source: r.source,
      })),
    });
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(goldenPath, json);
    expect(readFileSync(goldenPath, 'utf8')).toBe(json);
  });
});
