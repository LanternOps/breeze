import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { i18n } from './index';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Dynamic keys (t(variable)) cannot be checked statically; files using them add
// an explicit marker comment on the line: // i18n-dynamic
const T_CALL = /(?<![\w.])t\(\s*['"]([\w][\w.:-]*)['"]/g;
const USE_TRANSLATION = /useTranslation\(\s*['"]([\w-]+)['"]\s*\)/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__mocks__') yield* walk(path);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      yield path;
    }
  }
}

describe('translation key usage', () => {
  it('every literal t() key resolves in en', () => {
    const problems: string[] = [];
    for (const file of walk(srcDir)) {
      const source = readFileSync(file, 'utf8');
      const fileNamespace = source.match(USE_TRANSLATION)?.[1] ?? 'common';
      for (const line of source.split('\n')) {
        if (line.includes('i18n-dynamic')) continue;
        for (const match of line.matchAll(T_CALL)) {
          const raw = match[1];
          const [namespace, key] = raw.includes(':')
            ? raw.split(':', 2)
            : [fileNamespace, raw];
          if (!i18n.exists(key, { ns: namespace, lng: 'en' })) {
            problems.push(`${file.replace(srcDir, 'src')}: t('${raw}') → missing en ${namespace}:${key}`);
          }
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
