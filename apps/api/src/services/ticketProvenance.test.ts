import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUMAN_AUTHORITATIVE_PROVENANCE, isHumanAuthoritativeProvenance } from './ticketProvenance';

describe('ticket field provenance authority', () => {
  it('treats user and service_principal stamps as human-authoritative, nothing else', () => {
    expect([...HUMAN_AUTHORITATIVE_PROVENANCE]).toEqual(['user', 'service_principal']);
    expect(isHumanAuthoritativeProvenance('user')).toBe(true);
    expect(isHumanAuthoritativeProvenance('service_principal')).toBe(true);
    expect(isHumanAuthoritativeProvenance('ai_agent')).toBe(false);
    expect(isHumanAuthoritativeProvenance('system')).toBe(false);
    expect(isHumanAuthoritativeProvenance(undefined)).toBe(false);
    expect(isHumanAuthoritativeProvenance(null)).toBe(false);
  });

  // The guard that made the Partner API review (#7181) ask for a single
  // constant: a bare `=== 'user'` / `<> 'user'` provenance comparison in any
  // of the files that gate AI writes would silently let AI overwrite an
  // integration-set field.
  it('no provenance guard compares against a bare user literal', () => {
    const files = [
      'services/ticketService.ts',
      'services/aiAgents/ticketTriageFindings.ts',
    ];
    for (const rel of files) {
      const src = readFileSync(join(__dirname, '..', rel), 'utf8');
      const offenders = src.split('\n').filter((line) =>
        !/^\s*(\*|\/\/)/.test(line) && (
        /fieldProvenance[^\n]*(===|!==)\s*'user'/.test(line)
        || /field_provenance[^\n]*(<>|=)\s*'user'/.test(line)
        || /fieldProvenance\}->>[^\n]*(<>|=)\s*'user'/.test(line)),
      );
      expect(offenders, `${rel} compares provenance against a bare 'user' literal`).toEqual([]);
    }
  });
});
