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
2. Add the tag to `LOCALE_OPTIONS` in `apps/web/src/lib/appearance.ts`.
3. Add the tag to the locale allowlists in
   `apps/api/src/routes/users.ts` (PATCH /users/me).
4. Add an option to the user and partner Language controls in
   `apps/web/src/components/settings/ThemingSettings.tsx`.
5. Locale parity tests will fail until namespace files and keys match `en/` exactly.

Every extraction PR containing machine-drafted Portuguese must include:

`pt-BR strings are machine-drafted pending native review`

Do NOT translate `data-testid` values, log messages, or API payload values.
