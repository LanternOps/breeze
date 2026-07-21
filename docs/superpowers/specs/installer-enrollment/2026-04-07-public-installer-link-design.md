# Public Installer Link & AddDeviceModal Tests

**Date:** 2026-04-07
**Status:** Approved

## Summary

Add a "Generate Link" feature to the Add Device modal that creates a public, shareable download URL for the agent installer. Also add comprehensive tests for the AddDeviceModal component.

## Motivation

Currently, downloading an installer requires being logged into the Breeze web UI. MSPs need to share installer links with on-site technicians or customers who don't have Breeze accounts. A public link tied to an enrollment key solves this without compromising security.

## Design

### API: Public Download Endpoint

**Route:** `GET /enrollment-keys/public-download/:platform?token=<rawChildKey>`
**Auth:** None (the token IS the auth)
**File:** `apps/api/src/routes/enrollmentKeys.ts` — new `publicEnrollmentRoutes` Hono instance (no `authMiddleware`)

Flow:
1. Extract `token` from query params, `platform` from path
2. Hash token with `hashEnrollmentKey()`, look up enrollment key in DB
3. Validate: not expired, `usageCount < maxUsage`, has `siteId`
4. Fetch template binary (`fetchTemplateMsi` / `fetchMacosPkg`)
5. Inject credentials (`replaceMsiPlaceholders` / `buildMacosInstallerZip`)
6. Increment `usageCount` on the enrollment key
7. Stream installer to client
8. Audit log the download with `actorType: 'public_link'`

Security:
- Per-IP rate limit (10 requests/minute) via existing `rateLimiter`
- Token is a 32-byte random string — not guessable
- Usage count prevents unlimited downloads
- Expiration inherited from parent key

### API: Generate Link Endpoint

**Route:** `POST /:id/installer-link`
**Auth:** JWT + MFA (same as existing installer download)
**File:** `apps/api/src/routes/enrollmentKeys.ts` — on existing `enrollmentKeyRoutes`

Request body:
```json
{
  "platform": "windows" | "macos",
  "count": 1
}
```

Flow:
1. Look up parent enrollment key, verify org access
2. Validate parent key is not expired/exhausted and has `siteId`
3. Fetch template binary to verify it's available (fail fast, prevent orphan keys)
4. Create child enrollment key (same pattern as existing installer download):
   - Inherits `orgId`, `siteId`, `expiresAt`, `keySecretHash` from parent
   - `maxUsage` set to `count`
5. Return JSON:
```json
{
  "url": "<PUBLIC_API_URL>/api/v1/enrollment-keys/public-download/<platform>?token=<rawChildKey>",
  "expiresAt": "2026-04-14T00:00:00Z",
  "maxUsage": 5,
  "platform": "windows",
  "childKeyId": "uuid"
}
```

Audit log: `enrollment_key.installer_link_created`

### Route Mounting

In `apps/api/src/index.ts`:
- Mount `publicEnrollmentRoutes` on the `api` instance without auth middleware
- Place before the auth-protected enrollment key routes

### Frontend: Generate Link Button

**File:** `apps/web/src/components/devices/AddDeviceModal.tsx`

Add a "Generate Link" button alongside the existing "Download Installer" button in the installer tab:

- New state: `generatedLink`, `linkLoading`, `linkError`, `linkCopied`
- `handleGenerateLink()` calls `POST /enrollment-keys/:id/installer-link`
- On success, shows the URL in a read-only text input with a Copy button
- Shows expiration and usage limit text below the link
- Separate loading/error states from the download button
- Link persists until modal closes or user generates a new one

### Tests: AddDeviceModal.test.tsx

**File:** `apps/web/src/components/devices/AddDeviceModal.test.tsx`
**Framework:** Vitest + @testing-library/react

Mock targets:
- `../../stores/auth` → `fetchWithAuth`
- `../../stores/orgStore` → `useOrgStore`
- `../../lib/navigation` → `navigateTo`
- `../shared/Toast` → `showToast`

Test cases:
1. **Renders with site selector** — sites from org store appear in dropdown
2. **Shows "no sites" warning** — when org has no sites
3. **Download flow** — creates enrollment key, downloads installer, triggers blob download
4. **Generate Link flow** — creates enrollment key, calls link endpoint, displays URL
5. **Copy link** — copies generated URL to clipboard
6. **Platform switching** — toggling Windows/macOS updates state
7. **Device count** — input accepts valid numbers, clamps to 1-1000
8. **Error handling** — download failure, link generation failure show error messages
9. **MFA required** — 403 response shows MFA prompt
10. **CLI tab** — switching to CLI tab fetches onboarding token

## Files Changed

| File | Change |
|------|--------|
| `apps/api/src/routes/enrollmentKeys.ts` | Add `POST /:id/installer-link`, add `publicEnrollmentRoutes` with `GET /public-download/:platform` |
| `apps/api/src/index.ts` | Mount `publicEnrollmentRoutes` |
| `apps/web/src/components/devices/AddDeviceModal.tsx` | Add Generate Link button, link display, copy functionality |
| `apps/web/src/components/devices/AddDeviceModal.test.tsx` | New test file |

## Not In Scope

- Link revocation UI (can be done later via enrollment key management)
- Email/SMS sharing of links (user copies and shares manually)
- Linux installer links (Linux uses CLI enrollment, no packaged installer)
