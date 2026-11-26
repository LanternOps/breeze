import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POLICY_AUTOMATION_EVENT_TYPES } from '@breeze/shared';
import { POLICY_FEATURE_INLINE_SETTINGS_REFERENCE } from './aiToolsConfigPolicy';

// #12710: the configuration policy Automations tab and the AI tool offered
// event types nothing publishes, so an automation on one saved and never ran.
// Both now read POLICY_AUTOMATION_EVENT_TYPES; this ties that list to the
// publishers so it cannot drift again.

const API_SRC = join(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      sourceFiles(full, out);
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const publisherSources = sourceFiles(API_SRC)
  // The declaration of the type and constants is not a publisher.
  .filter((f) => relative(API_SRC, f) !== join('services', 'eventBus.ts'))
  .map((f) => readFileSync(f, 'utf8'));

describe('policy automation event types (#12710)', () => {
  // A bare string match would also pass on a schema column or a hook list, so
  // require an actual publishEvent('<type>' ...) call.
  it.each([...POLICY_AUTOMATION_EVENT_TYPES])('%s is published by a publishEvent call', (type) => {
    const call = new RegExp(`publishEvent(?:<[^>]*>)?\\(\\s*'${type.replace('.', '\\.')}'`);
    expect(publisherSources.some((src) => call.test(src)), `${type} is never published`).toBe(true);
  });

  // Negative control: the same matcher must reject a type that is only declared.
  it('the publisher matcher rejects a type with no publishEvent call', () => {
    const call = /publishEvent(?:<[^>]*>)?\(\s*'patch\.available'/;
    expect(publisherSources.some((src) => call.test(src))).toBe(false);
  });

  it('the docs reference row lists the same event types', () => {
    const mdx = readFileSync(join(API_SRC, '..', '..', 'docs', 'src', 'content', 'docs', 'features', 'ai-tools.mdx'), 'utf8');
    const row = mdx.split('\n').find((l) => l.startsWith('| `automation` |')) ?? '';
    const listed = row.match(/eventType\?: ([^,]+),/)?.[1]?.split('\\|').map((v) => v.trim().replace(/"/g, ''));
    expect(listed).toEqual([...POLICY_AUTOMATION_EVENT_TYPES]);
  });

  // Tripwire: if a publisher for either ships, move it into the shared list
  // deliberately and delete this assertion.
  it('never offers the two types nothing publishes', () => {
    expect(POLICY_AUTOMATION_EVENT_TYPES).not.toContain('compliance.failed');
    expect(POLICY_AUTOMATION_EVENT_TYPES).not.toContain('patch.available');
  });

  it('the AI tool automation reference advertises exactly the offered event types', () => {
    const ref = POLICY_FEATURE_INLINE_SETTINGS_REFERENCE.automation;
    const advertised = ref.match(/eventType\?: ([^,]+),/)?.[1]?.split('|').map((v) => v.trim().replace(/"/g, ''));
    expect(advertised).toEqual([...POLICY_AUTOMATION_EVENT_TYPES]);
  });
});
