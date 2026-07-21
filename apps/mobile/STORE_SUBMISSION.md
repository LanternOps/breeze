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

## Build, screenshots, and submission sequence

1. Regenerate the native project when app configuration changes: `npx expo prebuild --platform ios`. This carries the microphone and speech-recognition usage descriptions in `app.json` into the Xcode `Info.plist`.
2. Configure `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_POSTHOG_KEY`, and `EXPO_PUBLIC_POSTHOG_HOST` in the local Xcode release build environment only when their corresponding services are approved for release.
3. Run `npx pnpm@10.33.4 --filter=breeze-mobile typecheck` and `npx pnpm@10.33.4 --filter=breeze-mobile test`.
4. In Xcode, run the `BreezeRMM` scheme on a current iPhone and iPad simulator. Capture the reviewed production UI in the simulator, not the development error or debug overlay.
5. Save iPhone screenshots at the App Store Connect-required 6.5-inch size (1242 × 2688 or 1284 × 2778) and the iPad screenshots for the supported iPad display-size family. In Simulator, use **File → Save Screen** for each approved screen.
6. In Xcode, select a physical device or **Any iOS Device**, use **Product → Archive**, then upload the archive to App Store Connect. Attach the processed build to version 1.0.
7. Enter review notes and working reviewer credentials or an approved demo path, then submit the version to Apple for review.
