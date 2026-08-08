/**
 * Org slug helpers, shared by every org import source.
 *
 * Moved here from services/accounting/quickbooksCustomerImport.ts (#3242) so
 * the shared import pipeline and the QuickBooks importer use one
 * implementation; the old module re-exports these for back-compat.
 */

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/, ''); // re-trim: the 90-char slice can leave a dangling hyphen
  return slug || 'org';
}

export function generateUniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
