# Breeze RMM store-submission checklist

## Current configuration

- iOS bundle ID: `com.breeze.rmm`
- Android application ID: `com.breeze.rmm`
- Store version: `1.0.0`
- First local build numbers: iOS `1`; Android `1`
- The release path uses the local Xcode project; no Expo/EAS account is required.
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

## Sentry symbolication

Project: **olivetech-ks / breeze-mobile**. The DSN lives in `.env`
(`EXPO_PUBLIC_SENTRY_DSN`) and is a write-only client key, so it is fine that it
ships inside the IPA.

A DSN alone only makes events *arrive*. Making them *readable* needs two uploads,
both wired by the `@sentry/react-native/expo` plugin now that `app.json` passes
`organization` and `project`:

| Upload | Xcode build phase | Without it |
|---|---|---|
| JS source maps | "Bundle React Native code and images" (wrapped by `sentry-xcode.sh`) | every JS frame is a minified bundle offset |
| Native dSYMs | "Upload Debug Symbols to Sentry" | native crashes have no symbols |

Both need `SENTRY_AUTH_TOKEN`, which is a **genuine secret** (unlike the DSN).
Put it in `.env.sentry-build-plugin` — gitignored, and the officially-supported
location because **Xcode build phases do not inherit your shell environment**, so
exporting it in `.zshrc` and pressing Archive in Xcode.app does not work. Copy
`.env.sentry-build-plugin.example` to get started; scopes needed are
`project:releases` and `org:read`.

⚠️ **A missing or invalid token fails the Archive** — `sentry-xcode.sh` emits
`error: sentry-cli` and returns non-zero. That is the correct default (a silent
skip means unreadable traces nobody notices until the first crash), and
`pnpm preflight` now catches it before you start an archive. To deliberately
build without symbolication, set `SENTRY_ALLOW_FAILURE=true` (try, warn on
failure) or `SENTRY_DISABLE_AUTO_UPLOAD=true` (skip entirely).

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

Three constraints worth recording:

- The domain list is **static at build time** and can only name hosts we
  control, so **self-hosted Breeze servers can never be covered** by it. Their
  users get generic autofill, which is the same as today.
- `breezermm.com` was deliberately dropped: it is the marketing site behind
  Cloudflare, nobody signs into the app there, and claiming a domain that serves
  no AASA file just leaves an unanswered claim.
- Apple fetches the file through its CDN at install time, so changes are not
  instant; a build installed before the file went live needs a reinstall.

## Build, screenshots, and submission sequence

1. Regenerate the native project when app configuration changes: `npx expo prebuild --platform ios`. This carries the microphone and speech-recognition usage descriptions in `app.json` into the Xcode `Info.plist`, embeds the Geist fonts, and generates the splash screen and Associated Domains entitlement.
2. Configure `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_POSTHOG_KEY`, and `EXPO_PUBLIC_POSTHOG_HOST` in the local Xcode release build environment only when their corresponding services are approved for release. See `.env.example` for what each one does when left unset.
3. Run `npx pnpm@10.33.4 --filter=breeze-mobile preflight`. It fails the build when `EXPO_PUBLIC_SENTRY_DSN` is missing, `EXPO_PUBLIC_API_URL` is unreachable from a device, or `SENTRY_AUTH_TOKEN` is absent. The first two are silent in the running app — a release build without a DSN reports nothing at all, which is how a TestFlight build shipped with zero telemetry. The third is not silent but fails deep inside an Xcode build phase, so catching it here saves an archive cycle.
4. Run `npx pnpm@10.33.4 --filter=breeze-mobile typecheck` and `npx pnpm@10.33.4 --filter=breeze-mobile test`.
5. In Xcode, run the `BreezeRMM` scheme on a current iPhone and iPad simulator. Capture the reviewed production UI in the simulator, not the development error or debug overlay.
6. Save iPhone screenshots at the App Store Connect-required 6.5-inch size (1242 × 2688 or 1284 × 2778) and the iPad screenshots for the supported iPad display-size family. In Simulator, use **File → Save Screen** for each approved screen.
7. In Xcode, select a physical device or **Any iOS Device**, use **Product → Archive**, then upload the archive to App Store Connect. Attach the processed build to version 1.0.
8. Enter review notes and working reviewer credentials or an approved demo path, then submit the version to Apple for review.
