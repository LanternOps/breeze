# Web console translations

One folder per locale (BCP-47 tag), with one JSON namespace per product domain.
English namespaces are bundled eagerly for synchronous fallback rendering; all
other locales are discovered automatically and loaded lazily.

## Adding a string

1. Choose the component's domain namespace, such as `devices.json` or `settings.json`.
2. Add the structured key and English text to `en/<namespace>.json` (camelCase leaves).
3. Add the same key to every other locale's matching namespace file. Locale parity is enforced in tests.
4. In the component, declare the namespace once: `const { t } = useTranslation('devices')`, then call `t('list.empty')`.
5. Shared vocabulary uses an explicit namespace prefix, for example `t('common:actions.save')`.

Namespace files are auto-registered by `src/lib/i18n/index.ts`; adding one never
requires editing the registry. Import `@/lib/i18n` in the island tree to ensure
the shared instance is initialized.

## Adding a locale

1. Create `src/locales/<tag>/` and copy every namespace file from `en/`; translate values while keeping keys identical.
2. Add the tag to the shared `SupportedLocale` union in
   `packages/shared/src/types/index.ts`.
3. Add the tag to `LOCALE_OPTIONS` in `apps/web/src/lib/appearance.ts`.
4. Add the tag to the locale allowlists in
   `apps/api/src/routes/users.ts` (PATCH /users/me and partner-default filtering)
   and `apps/api/src/routes/orgs.ts` (partner settings validation).
5. Add an option to both Language controls:
   `apps/web/src/components/settings/ThemingSettings.tsx` for the user preference
   and `apps/web/src/components/settings/PartnerRegionalTab.tsx` for the partner default.
6. Add the tag to `translatedLocales` and record all reviewed per-namespace
   duplicate caps in `apps/web/src/lib/i18n/translationCoverage.test.ts`.
7. Locale parity tests will fail until namespace files and keys match `en/` exactly.

Language labels are written as self-names, while their descriptions are translated into the active UI language.

Every extraction PR containing machine-drafted Portuguese must include:

`pt-BR strings are machine-drafted pending native review`

The Spanish, French, and German catalogs are also machine drafts awaiting native review:

`es-419, fr-FR, fr-CA, and de-DE strings are machine-drafted pending native review`

Do NOT translate `data-testid` values, log messages, or API payload values.

## Conventions for extraction PRs

- **Interpolation:** `"deleteConfirm": "Delete {{name}}?"` → `t('deleteConfirm', { name: device.name })`. Never concatenate translated fragments.
- **Plurals:** `"deviceCount_one": "{{count}} device"`, `"deviceCount_other": "{{count}} devices"` → `t('deviceCount', { count })`. pt-BR uses the same `_one`/`_other` suffixes; add `_many` only if i18next warns because CLDR Portuguese handles the usual forms.
- **Rich text:** embedded markup uses `<Trans i18nKey="ns:key">plain <strong>bold</strong> text</Trans>` from `react-i18next`. Never split a sentence across multiple `t()` calls.
- **Reuse:** check `common:actions`, `common:states`, and `common:labels` before minting a key. A plain Save button is always `t('common:actions.save')`.
- **Scope:** translate visible text plus `placeholder`, `title`, `aria-label`, toast, and message strings. Do not translate `data-testid`, React keys, structural test fields, or API values.
- **Review flag:** every extraction PR with machine-drafted Portuguese includes the exact line `pt-BR strings are machine-drafted pending native review` in its description. PRs that add or substantially revise the Spanish, French, or German catalogs include `es-419, fr-FR, fr-CA, and de-DE strings are machine-drafted pending native review`.
