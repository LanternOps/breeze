import { semverCompare } from '@breeze/shared';
import { WEB_VERSION } from './version';
import { WHATS_NEW_ENTRIES, type WhatsNewEntry } from './whatsNew';

export const LAST_SEEN_KEY = 'breeze.whatsNew.lastSeenVersion';

export interface WhatsNewDecision {
  /** The entry to show, or null. */
  entry: WhatsNewEntry | null;
  /**
   * Set only when there is no stored floor AND nothing to show: the caller
   * writes this baseline so the *next* release still surfaces. When there is an
   * entry to show, this is null and the floor is written by "Got it" instead.
   */
  baselineToSet: string | null;
}

function highest(entries: WhatsNewEntry[]): WhatsNewEntry | null {
  return entries.reduce<WhatsNewEntry | null>((best, e) => {
    if (!best) return e;
    const c = semverCompare(e.version, best.version);
    return c !== null && c > 0 ? e : best;
  }, null);
}

/** Pure: storage is injected so it is trivially testable. */
export function decideWhatsNew(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  webVersion: string = WEB_VERSION,
  entries: WhatsNewEntry[] = WHATS_NEW_ENTRIES,
): WhatsNewDecision {
  if (webVersion === 'dev') return { entry: null, baselineToSet: null };

  // Treat an empty value as absent — a blank floor is not a version.
  const floor = storage.getItem(LAST_SEEN_KEY) || null;

  const applicable = entries.filter((e) => {
    const atMostWeb = semverCompare(e.version, webVersion);
    if (atMostWeb === null || atMostWeb > 0) return false;
    // No floor yet: every entry the running build shipped is a candidate, so
    // `highest` picks the release the user just landed on.
    if (floor === null) return true;
    const aboveFloor = semverCompare(e.version, floor);
    return aboveFloor !== null && aboveFloor > 0;
  });
  const entry = highest(applicable);

  // A missing floor means either a brand-new user or an existing user upgrading
  // from a build that predates this feature. The two are indistinguishable, and
  // baselining both away meant the entry that shipped the feature could never
  // auto-show (#3646). Both populations now see the newest shipped entry once.
  // Only when there is nothing to show do we write a baseline, so the next
  // release still surfaces.
  if (floor === null && !entry) return { entry: null, baselineToSet: webVersion };

  return { entry, baselineToSet: null };
}

export function markSeen(storage: Pick<Storage, 'setItem'>, version: string): void {
  storage.setItem(LAST_SEEN_KEY, version);
}

/** Newest entry the running build has shipped, ignoring dismissal (for reopen). */
export function latestApplicableEntry(
  webVersion: string = WEB_VERSION,
  entries: WhatsNewEntry[] = WHATS_NEW_ENTRIES,
): WhatsNewEntry | null {
  if (webVersion === 'dev') return highest(entries);
  const applicable = entries.filter((e) => {
    const c = semverCompare(e.version, webVersion);
    return c !== null && c <= 0;
  });
  return highest(applicable);
}
