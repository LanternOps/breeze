import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #9377 structural guard. The SSO callback / link-completion surface runs with
// NO request auth and NO ambient partner scope, so derivePartnerAttribution
// (services/auditEvents.ts) has nothing to fall back on: a writeRouteAudit
// there that omits a top-level `partnerId` persists partner_id NULL, and for a
// partner-level provider (org_id NULL) the row lands in no tenant's audit
// trail. A `details.partnerId` does not count. Behavioural tests cover the
// main paths; this catches the next copy-pasted rejection branch.

const ROUTES_DIR = __dirname;

/** Unauthenticated sources: everything from the /callback handler onward in
 * sso.ts (/callback, /exchange, /link/pending, /link/confirm, /check), plus
 * the /link/confirm finalizer. */
function unauthenticatedSources(): Array<{ name: string; text: string }> {
  const sso = readFileSync(join(ROUTES_DIR, 'sso.ts'), 'utf8');
  const start = sso.indexOf("ssoRoutes.get('/callback'");
  if (start < 0) throw new Error("sso.ts: /callback handler not found — update this guard's anchor");
  return [
    { name: 'sso.ts (/callback onward)', text: sso.slice(start) },
    { name: 'auth/ssoLinkCompletion.ts', text: readFileSync(join(ROUTES_DIR, 'auth/ssoLinkCompletion.ts'), 'utf8') },
  ];
}

/** Blanks string/template literals and comments (keeping newlines and
 * offsets) so braces inside them never affect depth. */
function stripLiteralsAndComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    let end = -1;
    if (ch === '/' && next === '/') end = text.indexOf('\n', i) - 1;
    else if (ch === '/' && next === '*') end = text.indexOf('*/', i + 2) + 1;
    else if (ch === "'" || ch === '"' || ch === '`') {
      end = i + 1;
      while (end < text.length && text[end] !== ch) end += text[end] === '\\' ? 2 : 1;
    }
    if (end < 0) { out += ch; continue; }
    if (end < i) end = text.length - 1;
    out += text.slice(i, end + 1).replace(/[^\n]/g, ' ');
    i = end;
  }
  return out;
}

/** The `{ ... }` argument of each `writeRouteAudit(c, { ... })` call. */
function extractAuditObjects(source: string): string[] {
  const text = stripLiteralsAndComments(source);
  const out: string[] = [];
  const marker = /writeRouteAudit\(\s*\w+\s*,\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(text))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) break;
    }
    // Return the ORIGINAL text so failure messages show the action name.
    out.push(source.slice(open, i + 1));
  }
  return out;
}

/** Keys of the object literal at nesting depth 1 (ignores `details: {...}`). */
function topLevelKeys(objectSource: string): Set<string> {
  const text = stripLiteralsAndComments(objectSource);
  const keys = new Set<string>();
  let depth = 0;
  for (const line of text.split('\n')) {
    if (depth === 1) {
      const key = /^\s*(\w+)\s*:/.exec(line);
      if (key) keys.add(key[1]!);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth--;
    }
  }
  return keys;
}

describe('SSO unauthenticated audit writes carry explicit tenancy (#9377)', () => {
  it('the helpers see top-level keys only', () => {
    const [obj] = extractAuditObjects(
      "writeRouteAudit(c, {\n  orgId: x,\n  action: 'a{',\n  details: { partnerId: p },\n});",
    );
    expect([...topLevelKeys(obj!)]).toEqual(['orgId', 'action', 'details']);
  });

  for (const { name, text } of unauthenticatedSources()) {
    it(`every writeRouteAudit in ${name} passes top-level orgId AND partnerId`, () => {
      const objects = extractAuditObjects(text);
      expect(objects.length).toBeGreaterThan(0);
      const missing = objects
        .filter((obj) => {
          const keys = topLevelKeys(obj);
          return !keys.has('orgId') || !keys.has('partnerId');
        })
        .map((obj) => /action:\s*([^\n]+)/.exec(obj)?.[1]?.trim() ?? obj.slice(0, 80));
      expect(missing).toEqual([]);
    });
  }
});
