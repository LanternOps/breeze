/**
 * Guard: data tables must not clip their right-hand columns on mobile.
 *
 * The recurring defect is a fixed-width table (`<table className="min-w-full">`)
 * wrapped in an `overflow-hidden` container. On any viewport narrower than the
 * table — i.e. every phone — the wrapper silently CLIPS the overflowing columns
 * (Type, status, Actions) with no scroll, so the data is unreachable. This was a
 * real user report and it existed in ~60 tables across the app.
 *
 * The fix is either the shared `ResponsiveTable` primitive
 * (apps/web/src/components/shared/ResponsiveTable.tsx — desktop scroll + mobile
 * cards) or, at minimum, swapping the wrapper to `overflow-x-auto`. This test
 * fails if a NEW table re-introduces the clipping wrapper, so the class of bug
 * can't grow back.
 *
 * It is a deliberately narrow lexical scan: it only flags an `overflow-hidden`
 * className that *immediately* wraps a `min-w-full` `<table>` (the exact offender
 * shape). It will not flag `overflow-hidden` used legitimately on cards, avatars,
 * progress bars, or panel shells.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src

/**
 * Files still carrying the clipping pattern that this PR intentionally did NOT
 * convert. The `devices/*` tabs are owned by a parallel branch (device-detail
 * UI work); converting them here would collide. Remove each entry as its table
 * is migrated to ResponsiveTable. This list must only ever SHRINK.
 */
const CLIPPED_TABLE_ALLOWLIST = new Set<string>([
  'components/devices/DeviceEffectiveConfigTab.tsx',
  'components/devices/DeviceHardwareInventory.tsx',
  'components/devices/DeviceScriptHistory.tsx',
]);

// An overflow-hidden className string immediately wrapping a min-w-full <table>.
const CLIPPING_WRAPPER =
  /className="[^"]*\boverflow-hidden\b[^"]*"\s*>\s*<table\b[^>]*\bmin-w-full\b/;

function collectTsx(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsx(full, acc);
    } else if (entry.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

describe('no clipped tables (mobile column-clipping guard)', () => {
  it('no .tsx (outside the shrinking allowlist) wraps a min-w-full table in overflow-hidden', () => {
    const offenders = collectTsx(SRC_ROOT)
      .filter((f) => CLIPPING_WRAPPER.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC_ROOT, f))
      .filter((rel) => !CLIPPED_TABLE_ALLOWLIST.has(rel))
      .sort();

    expect(
      offenders,
      `These tables clip their right-hand columns on mobile. Convert them to the ` +
        `shared ResponsiveTable primitive (or at minimum swap overflow-hidden → ` +
        `overflow-x-auto):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  }, 30_000);

  it('the allowlist only contains files that still match the pattern (keep it honest, shrink-only)', () => {
    const stale = [...CLIPPED_TABLE_ALLOWLIST].filter((rel) => {
      const full = resolve(SRC_ROOT, rel);
      try {
        return !CLIPPING_WRAPPER.test(readFileSync(full, 'utf8'));
      } catch {
        return true; // file moved/deleted → stale entry
      }
    });
    expect(
      stale,
      `These allowlist entries no longer clip (converted or removed) — delete them ` +
        `from CLIPPED_TABLE_ALLOWLIST:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
