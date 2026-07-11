# Web console translations

One folder per locale (BCP-47 tag), one `common.json` namespace per folder.

## Adding a string

1. Add the key + English text to `en/common.json` (structured keys: `area.thing`, camelCase leaves).
2. Add the translation to every other locale folder. Missing keys fall back to English at runtime — never to a raw key, as long as call sites pass `defaultValue`.
3. In components: `const { t } = useTranslation();` then `t('nav.dashboard', { defaultValue: 'Dashboard' })`.
   The component tree must have imported `@/lib/i18n` somewhere (module side effect initializes the shared instance).

## Adding a locale

1. Create `src/locales/<tag>/common.json` (copy `en/`, translate values, keep keys identical).
2. Register it in `apps/web/src/lib/i18n/index.ts` (resources map) and add the tag to
   `LOCALE_OPTIONS` in `apps/web/src/lib/appearance.ts`.
3. Add the tag to the `validatePreferenceEnum(prefs, 'locale', ...)` allowlist in
   `apps/api/src/routes/users.ts` (PATCH /users/me).
4. Add an option to the Language fieldset in
   `apps/web/src/components/settings/ThemingSettings.tsx`.
5. The key-parity test (`src/lib/i18n/i18n.test.ts`) will fail until keys match `en/` exactly.

Do NOT translate `data-testid` values, log messages, or API payload values.
