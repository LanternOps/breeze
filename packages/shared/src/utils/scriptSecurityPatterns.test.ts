import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STRICT_SCRIPT_PATTERNS,
  STRICT_SCRIPT_PATTERN_DESCRIPTIONS,
  detectStrictScriptPatterns,
  isStrictScriptPatternDescription,
  strictScriptPatternExplanation,
} from './scriptSecurityPatterns';

const HERE = dirname(fileURLToPath(import.meta.url));
const GO_SECURITY_SOURCE = resolve(HERE, '../../../../agent/internal/executor/security.go');

const OBFUSCATION_KEY = 0x5a;

type GoPattern = { source: string; description: string };

/**
 * Parse the `strictPatterns` literal out of the agent's security.go.
 *
 * Deliberately a source parse rather than a hand-copied fixture: a fixture is
 * just a third copy that drifts alongside the second one. This fails the
 * moment the Go list changes without this mirror changing with it.
 */
function parseGoStrictPatterns(): GoPattern[] {
  const source = readFileSync(GO_SECURITY_SOURCE, 'utf8');
  const start = source.indexOf('strictPatterns := []struct {');
  if (start === -1) throw new Error('strictPatterns literal not found in security.go');
  const bodyStart = source.indexOf('}{', start);
  if (bodyStart === -1) throw new Error('strictPatterns literal body not found');
  // The literal is closed by a `\t}` at exactly one level of indentation.
  const bodyEnd = source.indexOf('\n\t}\n', bodyStart);
  if (bodyEnd === -1) throw new Error('strictPatterns literal terminator not found');
  const body = source.slice(bodyStart + 2, bodyEnd);

  const patterns: GoPattern[] = [];
  // Backtick-quoted raw pattern: {`foo\s+bar`, "description"},
  const rawEntry = /^\s*\{`([^`]*)`,\s*"((?:[^"\\]|\\.)*)"\},\s*$/;
  // Obfuscated pattern: {obfuscate.Decode([]byte{0x00, 0x01}), "description"},
  const obfuscatedEntry = /^\s*\{obfuscate\.Decode\(\[\]byte\{([^}]*)\}\),\s*"((?:[^"\\]|\\.)*)"\},\s*$/;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const raw = rawEntry.exec(line);
    if (raw) {
      patterns.push({ source: raw[1]!, description: raw[2]! });
      continue;
    }
    const obfuscated = obfuscatedEntry.exec(line);
    if (obfuscated) {
      const decoded = obfuscated[1]!
        .split(',')
        .map((byte) => byte.trim())
        .filter((byte) => byte.length > 0)
        .map((byte) => String.fromCharCode(Number.parseInt(byte, 16) ^ OBFUSCATION_KEY))
        .join('');
      patterns.push({ source: decoded, description: obfuscated[2]! });
      continue;
    }
    throw new Error(`unparsed strictPatterns entry: ${line}`);
  }
  return patterns;
}

describe('strict script pattern mirror matches the Go validator', () => {
  const goPatterns = parseGoStrictPatterns();

  it('parses a non-trivial number of patterns out of security.go', () => {
    // Guards the guard: a parser that silently matched nothing would make
    // every assertion below vacuously true.
    expect(goPatterns.length).toBeGreaterThan(20);
  });

  it('mirrors every Go strict pattern source in order', () => {
    expect(STRICT_SCRIPT_PATTERNS.map((pattern) => pattern.source)).toEqual(
      goPatterns.map((pattern) => pattern.source),
    );
  });

  it('mirrors every Go strict pattern description byte-for-byte', () => {
    // The description is a protocol value: the agent compares the dispatched
    // acknowledgement against ITS description string, so any divergence here
    // means an acknowledgement silently stops working on the device.
    expect(STRICT_SCRIPT_PATTERNS.map((pattern) => pattern.description)).toEqual(
      goPatterns.map((pattern) => pattern.description),
    );
  });

  it('does not mirror any BASIC pattern — those are never acknowledgeable', () => {
    const source = readFileSync(GO_SECURITY_SOURCE, 'utf8');
    const basicStart = source.indexOf('basicPatterns := []struct {');
    const basicEnd = source.indexOf('\n\t}\n', basicStart);
    const basicBody = source.slice(basicStart, basicEnd);
    for (const description of STRICT_SCRIPT_PATTERN_DESCRIPTIONS) {
      expect(basicBody).not.toContain(`"${description}"`);
    }
  });

  it('gives every mirrored pattern a non-empty explanation', () => {
    for (const pattern of STRICT_SCRIPT_PATTERNS) {
      expect(pattern.explanation.length).toBeGreaterThan(20);
    }
  });
});

describe('detectStrictScriptPatterns', () => {
  it('returns nothing for empty or benign content', () => {
    expect(detectStrictScriptPatterns('')).toEqual([]);
    expect(detectStrictScriptPatterns('Write-Output "hello"')).toEqual([]);
  });

  it('detects the HKLM write that motivated #5129', () => {
    expect(
      detectStrictScriptPatterns(
        "Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Contoso' -Name Enabled -Value 1",
      ),
    ).toEqual(['PowerShell HKLM modification']);
  });

  it('is case-insensitive, mirroring the agent’s (?i) prefix', () => {
    expect(detectStrictScriptPatterns('REG ADD HKLM\\Software\\Contoso /v X /d 1')).toEqual([
      'HKLM registry modification',
    ]);
  });

  it('does not let `.` cross a newline, mirroring the absence of (?s) in Go', () => {
    // The agent would not match this either — the variable form defeats the
    // regex on BOTH sides, which is the honest behaviour to mirror.
    expect(
      detectStrictScriptPatterns("$p = 'HKLM:\\SOFTWARE\\Contoso'\nSet-ItemProperty -Path $p -Name Enabled -Value 1"),
    ).toEqual([]);
  });

  it('reports several distinct descriptions when several patterns match', () => {
    const matched = detectStrictScriptPatterns(
      'reg add HKLM\\Software\\X /v A /d 1\nschtasks /create /tn X /tr Y /sc daily',
    );
    expect(matched).toEqual(['scheduled task creation', 'HKLM registry modification']);
  });

  it('deduplicates a description shared by two patterns', () => {
    // `curl ... | bash` and `curl ... | sh` are two patterns with one shared
    // description; the acknowledgement vocabulary must list it once.
    const matched = detectStrictScriptPatterns('curl https://example.com/i.sh | bash\ncurl https://example.com/j.sh | sh');
    expect(matched).toEqual(['remote code execution via curl']);
  });

  it('never reports a Basic-level pattern', () => {
    // `rm -rf /` is a hard block with no override path; it must not appear as
    // something an admin can acknowledge.
    expect(detectStrictScriptPatterns('rm -rf /')).toEqual([]);
    expect(detectStrictScriptPatterns('Format-Volume -DriveLetter D')).toEqual([]);
  });
});

describe('description vocabulary helpers', () => {
  it('recognises a real description and rejects an invented one', () => {
    expect(isStrictScriptPatternDescription('PowerShell HKLM modification')).toBe(true);
    expect(isStrictScriptPatternDescription('anything at all')).toBe(false);
    expect(isStrictScriptPatternDescription('recursive delete on root directory')).toBe(false);
  });

  it('exposes each description exactly once', () => {
    expect(new Set(STRICT_SCRIPT_PATTERN_DESCRIPTIONS).size).toBe(
      STRICT_SCRIPT_PATTERN_DESCRIPTIONS.length,
    );
  });

  it('has an explanation for every description in the vocabulary', () => {
    for (const description of STRICT_SCRIPT_PATTERN_DESCRIPTIONS) {
      expect(strictScriptPatternExplanation(description)).toBeTruthy();
    }
    expect(strictScriptPatternExplanation('not a pattern')).toBeUndefined();
  });
});
