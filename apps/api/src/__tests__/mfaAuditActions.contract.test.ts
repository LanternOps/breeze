import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const authDir = join(import.meta.dirname, '..', 'routes', 'auth');
const docsPath = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'src',
  'content',
  'docs',
  'reference',
  'users-and-roles.mdx'
);

// Success audit actions that were already emitted but undocumented when this
// contract was added. FROZEN: it may only shrink. Document the action in the
// audit table of users-and-roles.mdx and delete it from this list.
const UNDOCUMENTED_AT_BASELINE = new Set<string>([
  'auth.mfa.recovery_code.used',
  'auth.mfa.sms.sent',
  'auth.mfa.stepup.granted',
  'auth.mfa.stepup.sms.sent',
]);

function emittedSuccessActions(): Set<string> {
  const found = new Set<string>();
  for (const name of readdirSync(authDir)) {
    if (!name.endsWith('.ts') || /\.(test|spec)\.ts$/.test(name)) continue;
    const text = readFileSync(join(authDir, name), 'utf8');
    for (const m of text.matchAll(/'(auth\.mfa\.[a-z0-9_.]+)'/g)) {
      const action = m[1];
      if (action && !action.endsWith('.failed')) found.add(action);
    }
  }
  return found;
}

function documentedActions(): Set<string> {
  const text = readFileSync(docsPath, 'utf8');
  return new Set([...text.matchAll(/^\|\s*`(auth\.mfa\.[a-z0-9_.]+)`\s*\|/gm)].flatMap((m) => (m[1] ? [m[1]] : [])));
}

describe('MFA audit actions are documented', () => {
  it('documents every emitted success action in the users-and-roles audit table', () => {
    const documented = documentedActions();
    const missing = [...emittedSuccessActions()]
      .filter((a) => !documented.has(a) && !UNDOCUMENTED_AT_BASELINE.has(a))
      .sort();
    expect(
      missing,
      `Add a row for each of these to the audit table in apps/docs/src/content/docs/reference/users-and-roles.mdx: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('keeps the undocumented allowlist shrinking: every entry is still emitted and still undocumented', () => {
    const emitted = emittedSuccessActions();
    const documented = documentedActions();
    const stale = [...UNDOCUMENTED_AT_BASELINE]
      .filter((a) => !emitted.has(a) || documented.has(a))
      .sort();
    expect(
      stale,
      `These allowlist entries are now documented or no longer emitted; delete them from UNDOCUMENTED_AT_BASELINE: ${stale.join(', ')}`
    ).toEqual([]);
  });
});
