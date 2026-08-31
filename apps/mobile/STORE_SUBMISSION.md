# Breeze RMM store-submission checklist

## Current configuration

- iOS bundle ID: `com.breeze.rmm`
- Android application ID: `com.breeze.rmm`
- Store version: `1.0.0`
- First local build numbers: iOS `1`; Android `1`
- The release path uses the local Xcode project; no Expo/EAS account is required. A committed `eas.json` exists so build-time config has a named home, but no EAS build has ever been run for this app.
- Apple Team ID: `D8W6N2JYMA` (LanternOps LLC)

## Push notifications — server side is already live

iOS push uses **native APNs**, not the Expo relay (#2333), so no Expo account is
needed. The provider credentials are configured in production on both regions
(key `8BYB6K2AZP`, team `D8W6N2JYMA`, topic `com.breeze.rmm`,
`APNS_ENVIRONMENT=production`).

⚠️ **`APNS_ENVIRONMENT=production` accepts TestFlight/App Store tokens only.** A
Debug build sideloaded from Xcode gets a *sandbox* token, which
`api.push.apple.com` rejects with `BadDeviceToken` — and the sender treats that
as permanently dead and **deletes the token from the database**. To test push
from a local Debug build, switch the droplets to `APNS_ENVIRONMENT=sandbox`
first.

Android push is **not wired**: the server skips raw FCM tokens, and `app.json`
no longer carries an Expo `projectId`, so `registerForPushNotifications()`
returns `unsupported`. Android launch needs either the projectId restored or a
real FCM sender added server-side.

## App Store Connect record

Create an iOS app record with:

- Name: **Breeze RMM**
- Primary language: English (U.S.)
- Bundle ID: `com.breeze.rmm`
- SKU: `breeze-rmm-ios`
- User access: Full Access

The app supports iPhone and iPad. Capture screenshots for every required iPhone and iPad display-size family after the first release candidate is installed.

## Metadata ready to enter

- Subtitle: `Manage and secure your IT fleet`
- Primary category: Business
- Secondary category: Productivity
- Support URL: `https://breezermm.com/`
- Marketing URL: `https://breezermm.com/`
- Privacy policy: `https://breezermm.com/legal/privacy-policy/`
- Terms: `https://breezermm.com/legal/terms-of-service/`
- Account deletion: `https://us.2breeze.app/account/delete` (or `https://eu.2breeze.app/account/delete`)
  - **Do not use `https://breezermm.com/account/delete` — it 404s.** That was the
    Guideline 5.1.1(v) bug fixed in #2325; the page is served per-region by the
    API, and in-app the URL is built from the user's selected server via
    `serverConfig.buildAccountDeletionUrl`.

Suggested description:

> Breeze RMM gives IT teams and managed service providers a secure mobile command center for their fleet. Review alerts, investigate managed systems, approve sensitive actions with biometric protection, and stay informed with push notifications. Sign in with your Breeze organization account to manage the systems you are authorized to access.

Suggested keywords: `IT management, RMM, remote monitoring, MSP, device management, IT operations, alerts`

## Privacy declaration

The implementation uses Sentry, PostHog (when configured), push notifications, biometric authentication, and optional voice input. Before submitting, complete the App Store Connect privacy questionnaire with the product and privacy owners. Code comments in `App.tsx` identify the implemented analytics collection; do not declare data collection that is disabled in the production environment.

Likely declarations to validate:

- Contact Info — Email Address: linked to the user; app functionality and analytics.
- Usage Data — Product Interaction: linked to the user; analytics.
- Diagnostics — Crash Data and Performance Data: app functionality and analytics.
- Identifiers — User ID and Device ID: linked to the user; app functionality, security, and analytics.

No IDFA or cross-app tracking is implemented, so App Tracking Transparency is not expected.

## Sentry — telemetry (the DSN)

⚠️ **History: the `breeze-mobile` Sentry project recorded zero events in 90
days.** Nothing was broken; every shipped build was simply archived without
`EXPO_PUBLIC_SENTRY_DSN`, and `Sentry.init({ enabled: false })` neither throws
nor logs. A guard existed (`scripts/preflight.mjs`) and was correct — it was
just never *run*, because the release path is a human pressing **Product →
Archive** in Xcode and preflight is a manual `pnpm preflight` step. Nothing in
the repo invoked it: no `eas.json`, no mobile build workflow, no Fastlane, no
archive script.

**A release build with no DSN now fails the build.** `app.config.js` calls
`resolveSentryDsn()` from `src/config/sentryDsn.js`, and that throws when it
sees a release build with a missing or placeholder DSN. That location is the
point: `expo-constants` installs an Xcode script build phase
(`:before_compile`, `always_out_of_date`) that runs `expo config` — i.e.
evaluates `app.config.js` — on **every** build, ⌘B and Archive alike. `expo
prebuild` and every Metro bundle evaluate it too. There is no path to an IPA
that skips it.

What counts as a release build: Xcode `CONFIGURATION` matching `Release`, any
EAS profile other than `development`, or `NODE_ENV=production`. Plain local dev,
`expo start`, a Debug build, a bare `expo prebuild`, and CI (`test-mobile` runs
vitest + `tsc` with no DSN anywhere) are all untouched.

⚠️ **`expo start --no-dev` does require a DSN.** Expo sets `NODE_ENV=production`
for it and it genuinely produces a `__DEV__ === false` bundle, which is the
whole point of the gesture — so the guard treats it as a release. Use
`BREEZE_MOBILE_DEV=1` for a throwaway one.

Two escape hatches, both taking the **literal string `1`** and nothing else (the
same spelling `scripts/preflight.mjs` uses; a near-miss like `=true` fails safe
by leaving the guard on). Both print a warning to stderr when they actually
suppress something:

| Flag | Effect |
|---|---|
| `BREEZE_MOBILE_ALLOW_NO_SENTRY=1` | Build a release deliberately without telemetry. Succeeds, warns. |
| `BREEZE_MOBILE_DEV=1` | **Disables the release check entirely** — a genuine Archive is treated as a dev build, so an IPA with no crash reporting can be produced. Warns whenever it suppresses a real release signal, but nothing stops that IPA being uploaded. **Never leave it in `apps/mobile/.env`**, which the Xcode build phase loads on every build. |

Where the DSN comes from:

| Build path | Source of truth | Notes |
|---|---|---|
| Local Xcode Archive (**current release path**) | `apps/mobile/.env` — gitignored, see `.env.example` | Must be in the **file**. Xcode build phases do not inherit your shell, so `export` in `.zshrc` + Archive does **not** work. |
| EAS Build (not currently used) | the EAS environment of the same name as the profile, referenced by `eas.json` | `eas env:create --environment <profile> --name EXPO_PUBLIC_SENTRY_DSN --value <dsn> --visibility sensitive` |

Every profile other than `development` is treated as a release, so
`eas build --profile preview` needs the DSN in the **`preview`** environment —
configuring `production` will not cover it. The failure message names the
environment matching the profile being built.

`eas.json` is committed and declares `development` / `preview` / `production`
profiles. It deliberately does **not** carry a DSN value: `env` in `eas.json`
outranks the EAS-stored environment variable, so a placeholder there would
shadow the real value on every build. Non-secret public config
(`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_POSTHOG_HOST`) is inline; the DSN is
referenced by environment name only. Note that EAS is not the release path
today — `eas.json` exists so the DSN has a committed, named home if it becomes
one.

The DSN is a write-only client key and ships inside the IPA either way, so it is
not a secret — but it is a live ingest endpoint, and per the repo's own rule
real environment values stay out of the public tree. Get it from
Sentry → **olivetech-ks / breeze-mobile** → Settings → Client Keys (DSN).
Placeholder-shaped values (`REPLACE_ME`, `changeme`, `example.com`, `TODO`, …)
are rejected, so a half-configured build fails loudly rather than posting events
to a host that does not exist.

At runtime the app reads the DSN from `EXPO_PUBLIC_SENTRY_DSN` **or**
`expoConfig.extra.sentryDsn`, which `app.config.js` writes. The two are produced
by different build phases (Metro transform vs. the expo-constants phase), so the
fallback guarantees the value the guard verified is the value that ships.

## Sentry — symbolication (source maps and dSYMs)

A DSN alone only makes events *arrive*. Making them *readable* needs two uploads,
both wired by the `@sentry/react-native/expo` plugin now that `app.json` passes
`organization` and `project`:

| Upload | Xcode build phase | Without it |
|---|---|---|
| JS source maps | "Bundle React Native code and images" (wrapped by `sentry-xcode.sh`) | every JS frame is a minified bundle offset |
| Native dSYMs | "Upload Debug Symbols to Sentry" | native crashes have no symbols |

`metro.config.js` uses `getSentryExpoConfig` (not `getDefaultConfig`), which
adds Sentry's asset-serialization plugin so the bundle and its source map carry
matching **Debug IDs**. Without them an uploaded map cannot be paired with the
bundle a crash came from, so frames stay minified even though the upload
reported success. This is the same class of failure as shipping without a DSN:
it looks like it worked.

Both need `SENTRY_AUTH_TOKEN`, which is a **genuine secret** (unlike the DSN).
Put it in `.env.sentry-build-plugin` — gitignored, and the officially-supported
location because **Xcode build phases do not inherit your shell environment**, so
exporting it in `.zshrc` and pressing Archive in Xcode.app does not work. Copy
`.env.sentry-build-plugin.example` to get started; scopes needed are
`project:releases` and `org:read`.

⚠️ **A missing or invalid token fails the Archive** — `sentry-xcode.sh` emits
`error: sentry-cli` and returns non-zero. That is the correct default (a silent
skip means unreadable traces nobody notices until the first crash). To
deliberately build without symbolication, set `SENTRY_ALLOW_FAILURE=true` (try,
warn on failure) or `SENTRY_DISABLE_AUTO_UPLOAD=true` (skip entirely).

Note the asymmetry that produced the 90-day telemetry gap: the auth token
self-enforced, because a missing one fails a build phase. The **DSN** — the
variable that actually decides whether events exist at all — had no build-phase
enforcement, only the optional `pnpm preflight`. The check that existed was
built for the failure mode that was already loud. That is what the
`app.config.js` guard above fixes.

`ios/sentry.properties` and `sentry.options.json` are generated during prebuild
and are both gitignored — do not hand-edit them, change `app.json` instead.

## Password autofill — Associated Domains (server-side step outstanding)

The login fields set `textContentType` (`username` / `password`), which is what
makes iOS offer iCloud Keychain and 1Password at all — `autoComplete` alone is
Android-only and was the reason no password manager ever appeared.

Getting managers to offer **the right saved entry** instead of a generic list
additionally needs the Associated Domains entitlement. `app.json` declares:

```
webcredentials:us.2breeze.app
webcredentials:eu.2breeze.app
```

Each of those hosts must serve an `apple-app-site-association` file at
`https://<host>/.well-known/apple-app-site-association` with content type
`application/json`, HTTP 200, and no redirects:

```json
{ "webcredentials": { "apps": ["D8W6N2JYMA.com.breeze.rmm"] } }
```

**Status: DONE on both regions (2026-07-26).** Served by Caddy, not the API — it
is a static 57-byte document, so this way it does not depend on an api image
rebuild. The block lives in `docker/Caddyfile.prod` in this repo and was applied
to `/opt/breeze/Caddyfile.prod` on `breeze-us` and `breeze-eu`, each backed up to
`Caddyfile.prod.bak-pre-aasa-*` first. Note that `/opt/breeze` is not a git repo,
so **a future Caddyfile redeploy from the repo must carry this block or the
association silently stops working**. Use `docker compose restart caddy`, not
`reload` — reload reports success without rebuilding `handle` ordering.

Verify with:

```bash
curl -sS -D- https://us.2breeze.app/.well-known/apple-app-site-association
```

Four constraints worth recording:

- The domain list is **static at build time**, because Apple binds Associated
  Domains into the signed entitlement. **The published App Store build therefore
  cannot cover a self-hosted server** — that is a platform constraint, not
  something a runtime setting can fix, and self-hosters should not chase it.
  Those users get generic autofill.
- A self-hoster **building the app themselves** can cover their own domain.
  `app.config.js` merges `BREEZE_ASSOCIATED_DOMAINS` into the list from
  `app.json`:

  ```bash
  BREEZE_ASSOCIATED_DOMAINS=breeze.example.com npx expo prebuild --platform ios
  ```

  Several entries may be separated by commas or whitespace, and a pasted URL is
  accepted (`https://breeze.example.com/login` resolves to the host). The two
  hosted regions above are always kept, so this can only add to the list and
  cannot break autofill for hosted users. The self-hosted server still has to
  serve the AASA file described above, with its own team ID and bundle
  identifier if the build is signed under a different Apple account.

  Only `webcredentials:` is emitted, and an entry that is not a usable hostname
  **fails the build** rather than being skipped — wildcards, IP addresses,
  `localhost`, and a bare host carrying a port or `?mode=developer` are all
  rejected by name. An internationalised domain is punycoded automatically,
  whether written bare or as a URL. Failing loudly is deliberate: a silently
  dropped entry would ship an entitlement missing the domain, and the only
  symptom would be autofill quietly not working. Edit `app.json` directly for
  anything beyond a plain password-manager association.
- `breezermm.com` was deliberately dropped: it is the marketing site behind
  Cloudflare, nobody signs into the app there, and claiming a domain that serves
  no AASA file just leaves an unanswered claim.
- Apple fetches the file through its CDN at install time, so changes are not
  instant; a build installed before the file went live needs a reinstall.

## Build, screenshots, and submission sequence

1. Regenerate the native project when app configuration changes: `npx expo prebuild --platform ios`. This carries the microphone and speech-recognition usage descriptions in `app.json` into the Xcode `Info.plist`, embeds the Geist fonts, and generates the splash screen and Associated Domains entitlement.
2. Put `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_API_URL`, and (when approved) `EXPO_PUBLIC_POSTHOG_KEY` / `EXPO_PUBLIC_POSTHOG_HOST` in **`apps/mobile/.env`** — the file, not your shell, because Xcode build phases do not inherit it. See `.env.example` for what each one does when left unset. Neither `EXPO_PUBLIC_SENTRY_DSN` nor `EXPO_PUBLIC_API_URL` is optional for a release build: the Archive fails without either (see "Sentry — telemetry" above and `src/config/apiUrl.js`). The API URL check also rejects `localhost`, a private-network address, and plaintext `http` to a public host. A genuinely LAN-hosted self-hosted build sets `BREEZE_MOBILE_ALLOW_PRIVATE_API_URL=1`, which accepts a private host (plaintext included) and warns on every build that it did; loopback, placeholders, and plaintext to a *public* host still fail.
3. Run `npx pnpm@10.33.4 --filter=breeze-mobile preflight`. **This is an optional convenience, not a gate** — nothing in the repo invokes it, and Xcode will never run it for you. It is worth running anyway for the one thing it still catches that the build-time guards do not: a missing `SENTRY_AUTH_TOKEN` (not silent, but it fails ten minutes into an archive instead of instantly here). Its DSN and API-URL checks are now echoes of the `app.config.js` guards, which cannot be skipped — the API-URL one literally calls the same rule function, so the two can never disagree.
4. Run `npx pnpm@10.33.4 --filter=breeze-mobile typecheck` and `npx pnpm@10.33.4 --filter=breeze-mobile test`.
5. In Xcode, run the `BreezeRMM` scheme on a current iPhone and iPad simulator. Capture the reviewed production UI in the simulator, not the development error or debug overlay.
6. Save iPhone screenshots at the App Store Connect-required 6.5-inch size (1242 × 2688 or 1284 × 2778) and the iPad screenshots for the supported iPad display-size family. In Simulator, use **File → Save Screen** for each approved screen.
7. In Xcode, select a physical device or **Any iOS Device**, use **Product → Archive**, then upload the archive to App Store Connect. Attach the processed build to version 1.0.
8. Enter review notes and working reviewer credentials or an approved demo path, then submit the version to Apple for review.
