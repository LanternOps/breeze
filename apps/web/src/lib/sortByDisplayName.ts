/**
 * Sorts a list of `{ name }` records by display name (pass-3 G2-2, PR #6459).
 *
 * The server orders paginated list routes by `created_at, id` and never by
 * name, so a walked-to-exhaustion list (`fetchAllOrganizations`,
 * `fetchAllSites`, and `orgStore`'s independent sites fetch) concatenates
 * pages in creation order. In a `<select>` that reads as "QA Org 078, 010,
 * 089, 014, …" instead of alphabetical — every caller of these shared
 * helpers inherits the fix from this one place.
 *
 * `localeCompare` with `numeric: true` orders "Org 2" before "Org 10" instead
 * of lexicographically; `sensitivity: 'base'` makes it case-insensitive so
 * "alpha" sorts with "Alpha", not after every capitalized name.
 */
export function sortByDisplayName<T extends { name?: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    (a?.name ?? '').localeCompare(b?.name ?? '', undefined, { sensitivity: 'base', numeric: true }),
  );
}
