# Web i18n next locales design

**Date:** 2026-07-13
**Status:** Approved for planning
**Locales:** Latin American Spanish (`es-419`), France French (`fr-FR`), Germany German (`de-DE`)

## Objective

Add complete, selectable translations for the Breeze web console in three new locales. Reuse the i18n architecture established by English and Brazilian Portuguese, preserve English as the eager fallback, and keep the three translation catalogs independent so they can be produced in parallel without merge conflicts.

The initial release uses machine-drafted translations pending native-speaker review. It must not imply that the catalogs have received professional or native linguistic certification.

## Why these locales

- `es-419` provides neutral Latin American Spanish without presenting Spain-specific vocabulary as universal Spanish.
- `fr-FR` is the standard first French locale for a broadly distributed European B2B application. A later `fr-CA` catalog can inherit its terminology decisions while changing regional language where necessary.
- `de-DE` serves the primary German-language enterprise software market. A later `de-AT` or `de-CH` catalog can be added independently.

The language controls display the self-names `Español (Latinoamérica)`, `Français (France)`, and `Deutsch (Deutschland)`.

## Existing architecture

The web console stores translations in `apps/web/src/locales/<locale>/<namespace>.json`. English is loaded eagerly and remains the synchronous fallback. Other locale folders are discovered automatically and lazily loaded by `apps/web/src/lib/i18n/index.ts`.

The English catalog currently contains 21 namespace files and approximately 16,431 leaf strings. Locale parity tests require every non-English locale to have exactly the same namespace files and keys as English. They also require interpolation variables such as `{{name}}` and `{{count}}` to remain unchanged.

Locale selection is also represented outside the catalogs:

- Web locale preference types and options define supported client values.
- User and partner appearance controls expose the available languages.
- API allowlists validate persisted user and partner locale preferences.
- Formatting helpers use the resolved locale for dates, times, numbers, and currency.

## Design

### Shared locale plumbing

One integration owner changes shared files once for all three locales. The shared change will:

1. Add `es-419`, `fr-FR`, and `de-DE` to the web locale preference type and `LOCALE_OPTIONS`.
2. Add all three identifiers to API validation allowlists for user and partner locale preferences.
3. Expose all three self-named options in user and partner language controls.
4. Generalize tests whose assertions currently assume only `en` and `pt-BR`.
5. Retain English fallback behavior and automatic lazy discovery; no locale-specific imports will be added.

Shared plumbing must land as one cohesive change. Translation workers do not edit these files.

### Parallel catalog ownership

Three independent workers each own exactly one new directory:

- Spanish worker: `apps/web/src/locales/es-419/**`
- French worker: `apps/web/src/locales/fr-FR/**`
- German worker: `apps/web/src/locales/de-DE/**`

Each worker starts from the complete English namespace set. Keys, nesting, interpolation variables, and rich-text placeholder structure remain identical. Only user-visible string values are translated.

Workers must not translate or alter:

- JSON keys
- `data-testid` values
- API enum values or payload literals embedded in explanatory examples
- product names, vendor names, command names, file paths, URLs, or code
- interpolation names inside `{{...}}`
- markup placeholder names used by `Trans`

Each catalog is delivered as a separate commit. The integration owner reviews and combines the commits in the shared worktree.

### Language style

All catalogs use concise, professional language for MSP technicians and internal IT teams. UI labels should be direct and consistent; help text should prioritize operational clarity over literal word-for-word translation.

#### Latin American Spanish

- Use neutral Latin American Spanish and `ustedes`; avoid `vosotros` and country-specific slang.
- Prefer broadly understood IT vocabulary such as `equipo` or `dispositivo` according to context.
- Use `aplicar parches` rather than forcing a colloquial verb where the phrase is clearer.
- Preserve established acronyms and technical terms when Spanish IT professionals normally use them, including RMM, MSP, SLA, API, PowerShell, SNMP, DNS, IP, and endpoint where replacing it would reduce precision.

#### France French

- Use professional France French and standard enterprise IT terminology.
- Prefer established French interface terms when they are unambiguous, while preserving common acronyms and product-specific technical terms.
- Use formal, neutral instructions rather than conversational regionalisms.

#### Germany German

- Use professional Germany German with consistent formal address. Prefer impersonal UI phrasing where possible; when direct address is required, use formal `Sie` forms consistently.
- Use established German enterprise IT compounds and preserve common English technical terms when they are the recognized industry term.
- Avoid Austrian- or Swiss-specific spellings and vocabulary in this catalog.

### Plurals, interpolation, and formatting

Translation values preserve all source interpolation variables. Plural suffixes follow i18next/CLDR behavior for each locale; workers may add only plural forms supported by the existing catalog and test conventions. Sentences containing markup remain complete translation units rather than concatenated fragments.

Date, number, relative-time, and currency formatting continue through the existing locale-aware formatting helpers. The new BCP-47 tags are passed directly to browser `Intl` APIs. No hand-written locale formatting logic is introduced.

### Loading and failure behavior

The existing lazy-loading coordinator remains unchanged. Selecting a new locale loads its namespace chunks, changes the i18next language, updates document metadata, and persists the preference through existing flows.

If a locale chunk fails to load, the existing error reporting and eager-English fallback remain authoritative. A partially translated or missing catalog must not be silently shipped: parity and quality tests fail before release.

## Quality controls

Automated verification will cover:

1. All three locale directories contain the same namespace files and keys as English.
2. Every translation preserves the English interpolation-token set.
3. JSON parses successfully and contains string leaves where expected.
4. Locale option, persistence, and API validation tests accept all three identifiers and reject unsupported values.
5. Existing i18n loading, race, fallback, and formatting tests continue to pass.
6. Web type-checking and the relevant API and web test suites pass.
7. A residue scan flags untranslated English duplicates for human review while allowing product names, acronyms, commands, and other intentional invariants.
8. A terminology review samples every namespace and checks high-risk operational language, destructive actions, security settings, billing, backup/restore, and remote access.

Each implementation PR states:

`es-419, fr-FR, and de-DE strings are machine-drafted pending native review`

## Parallel execution and integration

The shared plumbing and the three locale catalogs are independent work domains. After the implementation plan is approved, three translation agents work concurrently on isolated locale directories while the integration owner handles shared plumbing and review.

The integration owner will:

1. Prevent workers from editing shared files or another locale directory.
2. Review each catalog commit before integration.
3. Resolve terminology issues centrally rather than allowing cross-catalog edits by workers.
4. Run combined verification after all catalogs and shared changes are present.
5. Record any intentional English-equivalent values in the review evidence rather than weakening parity or interpolation checks.

## Scope boundaries

This work translates the existing web-console catalog and wires the three new choices into existing preference flows. It does not add server-rendered locale negotiation, translate API-generated prose outside the catalog, translate emails or generated documents that are not already catalog-backed, or claim native linguistic approval.

Regional follow-ups such as `es-ES`, `fr-CA`, `de-AT`, and `de-CH` are explicitly deferred. Their future addition must use separate locale tags and catalogs rather than changing the meaning of the locales introduced here.

## Completion criteria

The work is complete when all three languages can be selected and persisted for users and partners, each lazily loads a complete catalog, browser-owned metadata and locale-aware formatters follow the selection, unsupported locale values remain rejected, all scoped automated checks pass, and the machine-drafted review status is documented.
