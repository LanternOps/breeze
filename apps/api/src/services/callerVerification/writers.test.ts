// Source-inventory contract: every direct contact email/mobile writer records
// destination provenance. Behaviour tests live in the CRUD/import suites; this
// pins the set of writers so a new one cannot bypass provenance silently.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

const root = new URL('../..', import.meta.url).pathname;
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

it('every direct contact destination writer records provenance', () => {
  const known = ['services/contacts/crud.ts', 'services/contacts/compat.ts', 'services/contacts/import.ts'];
  const seen: string[] = [];
  for (const path of walk(root).filter((p) => p.endsWith('.ts') && !p.includes('.test.') && !p.includes('/__tests__/'))) {
    const s = readFileSync(path, 'utf8');
    if (!/\.(insert|update)\(contacts\)/.test(s)) continue;
    const rel = relative(root, path);
    if (['services/contacts/loginLink.ts', 'services/orgMergeCustomExecutors.ts'].includes(rel)) {
      expect(s).not.toMatch(/\.set\(\{[^}]*\b(email|mobile):/s);
      continue;
    }
    expect(known, `${rel} writes contacts without recording destination provenance`).toContain(rel);
    expect(s, rel).toContain('recordDestinationChange');
    seen.push(rel);
  }
  expect(seen.sort()).toEqual([...known].sort());
  const portal = readFileSync(join(root, 'routes/portal/profile.ts'), 'utf8');
  expect(portal).not.toMatch(/\.(insert|update)\(contacts\)/);
  for (const [p, source] of [
    ['routes/orgContacts.ts', 'technician'],
    ['services/inboundEmail/resolveOrg.ts', 'inbound_email'],
    ['services/aiToolsOrgs.ts', 'ai_tool'],
  ] as const) {
    expect(readFileSync(join(root, p), 'utf8'), p).toContain(`destinationSource: '${source}'`);
  }
});
