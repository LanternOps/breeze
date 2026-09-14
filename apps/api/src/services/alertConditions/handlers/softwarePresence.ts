/**
 * Software Presence condition handler (#5291 W04).
 *
 * Matches against the `softwareInventory` table by CASE-INSENSITIVE EQUALITY
 * on `name` (and, when supplied, `vendor`) — never a substring/`LIKE` match.
 * A substring match would make a "Chrome" monitor breach on "Google Chrome
 * Helper", "Chrome Remote Desktop Host", etc. When multiple installs match
 * (e.g. re-installed at a different path), the newest row by `lastSeen` wins.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { softwareInventory } from '../../../db/schema';
import type { ConditionHandler } from '../registry';
import type { ConditionResult } from '../types';

export interface SoftwarePresenceCondition {
  type: 'software_presence';
  name: string;
  vendor?: string;
  presence: 'installed' | 'not_installed' | 'version_below';
  version?: string;
}

/**
 * Compare two dotted version strings numerically, segment by segment
 * (missing trailing segments count as 0). Deliberately NOT a lexicographic
 * string comparison: '10.10' < '10.2' lexicographically but is numerically
 * greater, which would make a 'version_below' check breach on a device that
 * is actually up to date.
 *
 * Returns -1/0/1, or `null` if either version has a non-numeric segment —
 * callers must not guess in that case.
 */
function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const aParts = a.split('.');
  const bParts = b.split('.');
  const len = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < len; i++) {
    const aRaw = aParts[i] ?? '0';
    const bRaw = bParts[i] ?? '0';
    if (!/^\d+$/.test(aRaw) || !/^\d+$/.test(bRaw)) {
      return null;
    }
    const aNum = Number.parseInt(aRaw, 10);
    const bNum = Number.parseInt(bRaw, 10);
    if (aNum !== bNum) {
      return aNum < bNum ? -1 : 1;
    }
  }
  return 0;
}

export const softwarePresenceHandler: ConditionHandler = {
  type: 'software_presence',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as SoftwarePresenceCondition;

    const [latest] = await db
      .select({ name: softwareInventory.name, version: softwareInventory.version })
      .from(softwareInventory)
      .where(
        and(
          eq(softwareInventory.deviceId, deviceId),
          sql`lower(${softwareInventory.name}) = lower(${cond.name})`,
          ...(cond.vendor ? [sql`lower(${softwareInventory.vendor}) = lower(${cond.vendor})`] : [])
        )
      )
      .orderBy(desc(softwareInventory.lastSeen))
      .limit(1);

    if (cond.presence === 'not_installed') {
      // Breaches when NOTHING matches — the software is expected to be absent.
      const passed = !latest;
      return {
        passed,
        description: passed ? `${cond.name} is not installed` : `${cond.name} is installed`,
      };
    }

    if (cond.presence === 'installed') {
      // Breaches when a row DOES match — "alert me that this IS installed"
      // (e.g. disallowed software). This is the polarity most likely to be
      // misread as "alert me if it's missing" — it is not; that's 'not_installed'.
      const passed = !!latest;
      return {
        passed,
        description: passed ? `${cond.name} is installed` : `${cond.name} is not installed`,
      };
    }

    // presence === 'version_below'
    if (!latest || !latest.version) {
      // Nothing installed (or no version recorded) is not "below" anything.
      return { passed: false, description: `${cond.name} is not installed` };
    }

    const comparison = compareVersions(latest.version, cond.version as string);
    if (comparison === null) {
      return { passed: false, description: `Version ${latest.version} not comparable` };
    }

    const passed = comparison < 0;
    return {
      passed,
      description: passed
        ? `${cond.name} version ${latest.version} is below ${cond.version}`
        : `${cond.name} version ${latest.version} is not below ${cond.version}`,
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (typeof c.name !== 'string' || c.name.trim().length === 0) {
      errors.push(`${path}.name: Must be a non-empty string`);
    }
    if (!['installed', 'not_installed', 'version_below'].includes(c.presence as string)) {
      errors.push(`${path}.presence: Must be one of installed, not_installed, version_below`);
    }
    if (c.presence === 'version_below' && (typeof c.version !== 'string' || c.version.trim().length === 0)) {
      errors.push(`${path}.version: Required when presence is version_below`);
    }

    return errors;
  },
};
