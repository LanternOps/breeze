import type { SourceHandle, SourcePerson } from '../../moduleContract';
import { zammadPeople } from './directory';

/**
 * Names for the people a report names by key (#8313 W6; spec 2026-10-19
 * §5.10): `owner_unmatched` rows carry the Zammad user id, and the wizard
 * shows the person by reading the source's users live. Read through the
 * directory (the users index the loads already page, cached 30 minutes in
 * this process, dropped with the run), so a report page costs at most one
 * index read plus one request per user created since. A key that is not a
 * Zammad user id, or a user the source does not have, is null.
 */
const ZAMMAD_USER_KEY = /^[1-9]\d{0,11}$/;

export async function resolveZammadPeople(src: SourceHandle<unknown>, keys: readonly string[]): Promise<Map<string, SourcePerson | null>> {
  const out = new Map<string, SourcePerson | null>();
  const ids = new Map<number, string[]>();
  for (const key of keys) {
    if (!ZAMMAD_USER_KEY.test(key)) {
      out.set(key, null);
      continue;
    }
    const id = Number(key);
    ids.set(id, [...(ids.get(id) ?? []), key]);
  }
  if (ids.size === 0) return out;
  const people = await zammadPeople(src, ids.keys());
  for (const [id, sameKeys] of ids) {
    const person = people.get(id) ?? null;
    const name = person ? [person.firstname, person.lastname].filter(Boolean).join(' ').trim() || person.login : null;
    for (const key of sameKeys) out.set(key, person ? { name: name || null, email: person.email || null } : null);
  }
  return out;
}
