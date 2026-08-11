import { semverCompare } from '@breeze/shared';
import { WEB_VERSION } from './version';
import { WHATS_NEW_ENTRIES, type WhatsNewEntry } from './whatsNew';

export const LAST_SEEN_KEY = 'breeze.whatsNew.lastSeenVersion';

export interface WhatsNewDecision {
  /** The entry to show, or null. */
  entry: WhatsNewEntry | null;
  /** First-ever load only: caller writes this baseline and shows nothing. */
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

  const floor = storage.getItem(LAST_SEEN_KEY);
  if (!floor) return { entry: null, baselineToSet: webVersion };

  const applicable = entries.filter((e) => {
    const aboveFloor = semverCompare(e.version, floor);
    const atMostWeb = semverCompare(e.version, webVersion);
    return aboveFloor !== null && aboveFloor > 0 && atMostWeb !== null && atMostWeb <= 0;
  });
  return { entry: highest(applicable), baselineToSet: null };
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
