/**
 * Registry shape + invariant 3 (secret-name guard) + docsUrl existence.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONNECTION_REGISTRY, SECRET_NAME_EXCEPTIONS, SECRET_NAME_PATTERN } from './registry';
import { CONNECTION_GROUPS } from './types';

const DOCS_CONTENT_DIR = join(__dirname, '..', '..', '..', '..', 'docs', 'src', 'content', 'docs');
const allVars = CONNECTION_REGISTRY.flatMap((entry) => entry.vars.map((v) => ({ entry: entry.id, ...v })));

describe('connection registry shape', () => {
  it('has unique kebab-case ids, known groups and non-empty labels', () => {
    const ids = CONNECTION_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CONNECTION_REGISTRY) {
      expect(entry.id, entry.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(CONNECTION_GROUPS, entry.id).toContain(entry.group);
      expect(entry.label.trim(), entry.id).not.toBe('');
      expect(entry.vars.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('lists every env var in at most one entry', () => {
    const names = allVars.map((v) => v.name);
    const dupes = names.filter((name, i) => names.indexOf(name) !== i);
    expect(dupes).toEqual([]);
  });

  it('covers every group at least once', () => {
    for (const group of CONNECTION_GROUPS) {
      expect(CONNECTION_REGISTRY.some((e) => e.group === group), group).toBe(true);
    }
  });

  it('every docsUrl points at a page that exists under apps/docs', () => {
    for (const entry of CONNECTION_REGISTRY) {
      if (!entry.docsUrl) continue;
      expect(entry.docsUrl, entry.id).toMatch(/^\/[a-z0-9-]+(\/[a-z0-9-]+)*\/(#[a-z0-9-]+)?$/);
      const pagePath = entry.docsUrl.split('#')[0]!.replace(/^\/|\/$/g, '');
      const candidates = [join(DOCS_CONTENT_DIR, `${pagePath}.mdx`), join(DOCS_CONTENT_DIR, `${pagePath}.md`), join(DOCS_CONTENT_DIR, pagePath, 'index.mdx')];
      expect(candidates.some((p) => existsSync(p)), `${entry.id} → ${entry.docsUrl}`).toBe(true);
    }
  });
});

describe('invariant 3: secret-name guard', () => {
  it('a secret-looking name stays secret unless SECRET_NAME_EXCEPTIONS explains why it is not', () => {
    const offenders = allVars
      .filter((v) => v.secret === false && SECRET_NAME_PATTERN.test(v.name) && !(v.name in SECRET_NAME_EXCEPTIONS))
      .map((v) => `${v.entry}:${v.name}`);
    expect(offenders).toEqual([]);
  });

  it('every exception is a live secret:false registry var with a reason (no stale exceptions)', () => {
    for (const [name, reason] of Object.entries(SECRET_NAME_EXCEPTIONS)) {
      const v = allVars.find((candidate) => candidate.name === name);
      expect(v, `${name} is not in the registry`).toBeDefined();
      expect(v?.secret, `${name} is excepted but not secret:false`).toBe(false);
      expect(SECRET_NAME_PATTERN.test(name), `${name} does not need an exception`).toBe(true);
      expect(reason.trim().length, name).toBeGreaterThan(10);
    }
  });

  it('the pattern catches the spec-named traps', () => {
    for (const name of ['DATABASE_URL_APP', 'FIREBASE_SERVICE_ACCOUNT', 'PLAY_INTEGRITY_SERVICE_ACCOUNT', 'CSP_REPORT_URI', 'TWILIO_ACCOUNT_SID', 'SENSITIVE_DATA_ENCRYPTION_KEY_B64']) {
      expect(SECRET_NAME_PATTERN.test(name), name).toBe(true);
      expect(allVars.find((v) => v.name === name)?.secret, name).not.toBe(false);
    }
  });
});
