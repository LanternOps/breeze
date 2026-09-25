/**
 * Guard: the legacy `notification_channels.config` column is WRITE-ONLY (#6379,
 * expand step).
 *
 * The column still exists in the database for one release so an image rollback
 * keeps delivering alerts, and writeNotificationChannelConfig mirrors every
 * config write into it. Nothing in this image may READ it: config is read only
 * from notification_channel_configs, whose RLS hides a partner-wide channel's
 * config from org sessions. A reader of the legacy column would reopen the leak
 * through the application.
 *
 * Remove this file together with the column (contract step of #6379).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { notificationChannels } from '../db/schema';

const SRC = join(__dirname, '..');
const SERVICE = 'services/notificationChannelConfig.ts';
const LEGACY_VIEW = 'legacyNotificationChannelConfigColumn';

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) productionSources(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(SRC, file).split(sep).join('/');

describe('legacy notification_channels.config is write-only (#6379 expand step)', () => {
  it('is not a column of the notificationChannels schema object, so select()/returning() never read it', () => {
    const columns = getTableColumns(notificationChannels);
    expect(Object.keys(columns)).not.toContain('config');
    expect(Object.values(columns).map((c) => c.name)).not.toContain('config');
  });

  it('only the schema and the config service declare a Drizzle table over notification_channels', () => {
    const declaring = productionSources(SRC)
      .filter((file) => /pgTable\(\s*['"]notification_channels['"]/.test(readFileSync(file, 'utf8')))
      .map(rel)
      .sort();
    expect(declaring).toEqual(['db/schema/alerts.ts', SERVICE]);
  });

  it('the legacy view is module-private and used only as an UPDATE target', () => {
    const source = readFileSync(join(SRC, SERVICE), 'utf8');
    expect(source).not.toMatch(new RegExp(`export\\s+(const|let|var)\\s+${LEGACY_VIEW}\\b`));
    expect(source).not.toMatch(new RegExp(`export\\s*\\{[^}]*\\b${LEGACY_VIEW}\\b`));

    const uses = [...source.matchAll(new RegExp(`\\b${LEGACY_VIEW}\\b`, 'g'))].map((m) => {
      const lineStart = source.lastIndexOf('\n', m.index!) + 1;
      const lineEnd = source.indexOf('\n', m.index!);
      return source.slice(lineStart, lineEnd).trim();
    });
    const allowed = [
      `const ${LEGACY_VIEW} = pgTable('notification_channels', {`,
      `.update(${LEGACY_VIEW})`,
      `.where(eq(${LEGACY_VIEW}.id, channelId));`,
    ];
    // Doc comments may name it; code may only declare it and UPDATE through it.
    const code = uses.filter((line) => !line.startsWith('*') && !line.startsWith('//'));
    expect(code.sort()).toEqual([...allowed].sort());
  });

  it('no other production file references the legacy view', () => {
    const offenders = productionSources(SRC)
      .filter((file) => rel(file) !== SERVICE && readFileSync(file, 'utf8').includes(LEGACY_VIEW))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
