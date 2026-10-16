import { SETTINGS_CATALOG, type SettingsGroup } from './settingsCatalog';
import { isNavGateVisible, type NavGateContext } from './navGates';

export interface SettingsSearchHit {
  id: string;
  title: string;
  description: string;
  href: string;
  group: SettingsGroup;
}

/** Resolves an i18n key with an English fallback (`t(key, { defaultValue })`). */
export type SettingsTranslate = (key: string, fallback: string) => string;

/**
 * Settings results for the Cmd+K palette (#8365). Built from the same
 * `SETTINGS_CATALOG` the /settings index and sidebar render, filtered by the
 * same `isNavGateVisible` predicate, so a screen the nav hides never shows up in
 * search and a screen in the nav is always findable. Lives client-side because
 * labels are localized and several gates (autopay, tool sources, service-desk
 * module) are only known to the web app.
 */
export function searchSettingsCatalog(
  query: string,
  ctx: NavGateContext,
  translate: SettingsTranslate,
): SettingsSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const hits: SettingsSearchHit[] = [];
  for (const entry of SETTINGS_CATALOG) {
    if (!isNavGateVisible(entry, ctx)) continue;
    const title = translate(entry.labelKey, entry.name);
    const description = entry.descriptionKey ? translate(entry.descriptionKey, '') : '';
    const haystack = `${title} ${entry.name} ${description}`.toLowerCase();
    if (haystack.includes(needle)) {
      hits.push({ id: entry.id, title, description, href: entry.href, group: entry.group });
    }
  }
  return hits;
}
