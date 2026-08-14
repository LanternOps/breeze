/**
 * Coerce an API list response into an array.
 *
 * Breeze list endpoints answer one of a few shapes:
 *   - `{ data, pagination }` — the modern default (devices, scripts, policies, sites, …)
 *   - `{ data, total }` — device-groups and a few others
 *   - `{ <plural>: [...] }` — legacy endpoints that never moved to the envelope
 *   - a bare array — a handful of older internal routes
 *
 * Callers used to spell this inline as `data.data ?? data.sites ?? data ?? []`.
 * That idiom is a footgun: `??` only falls through on null/undefined, so a
 * response whose keys don't match (an error body returned with HTTP 200, a
 * renamed field, a wrong URL that 404s into a JSON error) lands on the bare
 * `data` term and stores the **envelope object** in React state. The component
 * then throws `X.map is not a function` during render, React unmounts the
 * island, and the page goes blank with nothing in the UI to explain it. That is
 * exactly how `/devices/groups` shipped broken.
 *
 * `asList` fails closed to `[]` instead: a shape we don't recognise renders an
 * empty list, which is visible, recoverable, and never crashes the island.
 *
 * `T` defaults to `any` on purpose. Callers feed this the result of
 * `response.json()`, which is already `any` — defaulting to `unknown` would
 * make this a *typing* change on 30+ untouched call sites and buy nothing real,
 * since the honest alternative (`asList<EncryptionKey>(payload)`) is an
 * unchecked cast either way. Pass an explicit type argument where the shape is
 * actually validated; the runtime guarantee — always an array — is the point.
 *
 * @param payload  Parsed JSON body.
 * @param aliasKeys Legacy key(s) to accept besides `data`, e.g. `'sites'`.
 *                  Order between `data` and the aliases is immaterial — a
 *                  response carries one or the other, never both.
 */
export function asList<T = any>(payload: unknown, ...aliasKeys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data as T[];
    for (const key of aliasKeys) {
      if (Array.isArray(record[key])) return record[key] as T[];
    }
    // Failing closed is the design, but a SILENT empty list would erase the
    // only forensic trail when an endpoint's shape drifts (renamed field,
    // error body returned with HTTP 200). An object that carried no
    // recognizable list is exactly that drift — leave a pulse.
    console.warn(
      '[asList] unrecognized list payload shape; failing closed to []',
      { keys: Object.keys(record), aliasKeys },
    );
  }
  return [];
}
