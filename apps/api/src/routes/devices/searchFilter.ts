import { ilike, or, type SQL } from 'drizzle-orm';
import { devices } from '../../db/schema/devices';
import { escapeLike } from '../../utils/sql';

/**
 * `GET /devices?search=` filter: the typed text against the hostname OR the
 * display name, case-insensitively, with LIKE wildcards in the text escaped.
 * The Wisp entity picker (W08) and the devices list both send a person's
 * typed text here; a case-sensitive hostname-only match meant "macOS" could
 * not find "E2E macOS Test Device" (hostname e2e-macos.local).
 */
export function deviceSearchCondition(term: string): SQL {
  const pattern = `%${escapeLike(term)}%`;
  return or(ilike(devices.hostname, pattern), ilike(devices.displayName, pattern)) as SQL;
}
