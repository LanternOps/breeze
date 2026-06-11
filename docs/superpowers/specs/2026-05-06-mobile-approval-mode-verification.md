# Mobile Approval Mode — Verification Checklist

> Companion to `docs/superpowers/plans/2026-05-06-mobile-approval-mode.md`. Phase 1 (approval mode) implementation is complete on `feat/mobile-approval-mode`. This is the manual verification pass for Task 16.

## What's already verified deterministically

- ✅ All 9 API route tests green (`pnpm test src/routes/approvals.test.ts`)
- ✅ All 4 Expo Push dispatcher tests green (`pnpm test src/services/expoPush.test.ts`)
- ✅ RLS contract test green — `approval_requests` in `USER_ID_SCOPED_TABLES`, cross-user INSERT rejected as `breeze_app`
- ✅ `approval_requests` table migrated; idempotent re-apply confirmed
- ✅ Routes mounted at `/api/v1/mobile/approvals/*` (returns 401 unauth, not 404)
- ✅ Mobile typecheck clean across all new files
- ✅ Docker `breeze-api` container hot-reloaded the new code (tsx watch picks up from mounted `apps/api/src`)

## Pre-verification setup (one-time)

### 1. Set the EAS project ID

`apps/mobile/app.json` currently has `expo.extra.eas.projectId: ""`. Push delivery needs this filled in:

```bash
cd apps/mobile
npx eas init
```

This creates the EAS project (asks you to log in to your Expo account if needed) and writes the project ID into `app.json`. The runtime check in `services/notifications.ts` will throw an actionable `'EAS projectId missing — run \`eas init\`'` until this is done.

### 2. Mobile rebuild

If your simulator already has the previous build (sim/login work), the new approval-mode code requires a rebuild because `react-native-svg`, `expo-font`, `expo-haptics`, `expo-constants` were added (native modules):

```bash
cd apps/mobile
npx expo run:ios
# or
npx expo run:android
```

## Verification steps (run on simulator/device)

### A. Push token registration

1. Launch the app on simulator/device.
2. Sign in.
3. Grant push notification permission when prompted.
4. Confirm the token landed in the DB:
   ```bash
   docker exec breeze-postgres psql -U breeze -d breeze -c \
     "SELECT user_id, platform, fcm_token IS NOT NULL OR apns_token IS NOT NULL AS has_token FROM mobile_devices;"
   ```
   Expected: a row with `has_token = t` for your user. The token will be `ExponentPushToken[xxx]` shape.

### B. Seed an approval (happy path)

Get a JWT for your authed user. Easiest path: grab it from `expo-secure-store` via a debug print, or copy from the simulator's local storage.

```bash
TOKEN="<paste JWT here>"
curl -X POST http://localhost:3001/api/v1/mobile/approvals/dev/seed \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "actionLabel": "Delete 4 devices in Acme Corp",
    "actionToolName": "breeze.devices.delete",
    "actionArguments": {"ids": ["a","b","c","d"]},
    "riskTier": "high",
    "riskSummary": "High impact: deletes data. Reversible within 30 days.",
    "requestingClientLabel": "Claude Desktop",
    "requestingMachineLabel": "Test Machine",
    "expiresInSeconds": 60
  }'
```

Expected on the phone, in order:
1. ✓ Push notification arrives within ~5s. Lock-screen text: "Approval requested — Claude Desktop: Delete 4 devices in Acme Corp."
2. ✓ Tapping the notification opens the app directly into approval mode.
3. ✓ The countdown ring is visible at top-left, ticking down.
4. ✓ Action headline reads in display-size: *"Delete 4 devices in Acme Corp."*
5. ✓ Risk band is red ("High impact") with the summary.
6. ✓ Tapping "Show details" expands the mono tool name + JSON args.
7. ✓ Tapping Approve triggers biometric. On success: green wash sweeps up, success haptic, toast reads "Approved · Delete 4 devices in Acme Corp."
8. ✓ DB row updated: `status='approved'`, `decided_at` populated.

### C. Deny with reason

Seed another approval. Tap Deny → reason sheet slides up from bottom → submit empty → toast reads "Denied · logged".

DB: `status='denied'`, `decided_at` populated, `decision_reason` is null.

### D. Expiry

Seed with `"expiresInSeconds": 15`. Open the app immediately. Watch the ring complete. The screen dims silently (no haptic). Status updates to `expired` locally via `markExpired` reducer. (Server-side expiry is implicit — `expires_at` comparison in route handlers; no background job marks rows yet.)

### E. Recursive hold

Seed with `"requestingClientLabel": "Breeze Mobile"`. The Approve button becomes a "Hold to approve" bar with a teal progress fill. Holding for the full 5s should fire biometric, then approve.

### F. Offline cold open

1. Seed an approval with `"expiresInSeconds": 600`.
2. Verify it renders in the app.
3. Toggle airplane mode ON.
4. Force-quit the app.
5. Reopen with airplane mode still on.

Expected: approval still renders (from `expo-secure-store` cache).

Tapping Approve will fail (no network) — this is acceptable for v1. Brief promised offline *render*, not offline *approval*.

### G. Tear down test data

```bash
docker exec breeze-postgres psql -U breeze -d breeze -c \
  "DELETE FROM approval_requests WHERE requesting_client_label IN ('Dev Seed','Claude Desktop','Breeze Mobile');"
```

## Known limits (acceptable for v1)

- **EAS project ID required for push.** Without `npx eas init`, the `getExpoPushTokenAsync` call throws an actionable error and no push is delivered. The approval screen still renders if you open the app cold after seeding (`refreshPending` thunk fetches and `setFocus` lands on the first pending row). Lock-screen push specifically needs EAS.
- **Server expiry is implicit.** Routes refuse to approve/deny rows past `expires_at`, but no background job flips `status` to `expired`. Mobile UI handles this via `markExpired` locally on countdown completion. A cleanup job is a follow-up.
- **`isRecursive` heuristic** matches on `requestingClientLabel.startsWith('Breeze Mobile')`. A server-issued `isRecursive` flag is the proper fix for phase 2.
- **Report-as-suspicious** is a stub Pressable with no onPress — phase 2.
- **Multi-pending swipe** not implemented — focus is single-id v1; second pending shows next after the first decision lands.
- **Light mode** tokens defined but not iterated; dark is canonical.

## What's NOT in this branch

- Hooking step-up enforcement into actual MCP tool calls (so the system that *creates* approvals on real MCP traffic is unbuilt — the dev/seed endpoint is the way to exercise the surface).
- AI tab, Systems tab, Settings polish (phases 2 and 3 of the broader mobile design plan).
- `useAppDispatch`/`useAppSelector` migration if other slices in the app still use raw `useDispatch`/`useSelector` (no-op for now).

## Branch summary

```bash
git log feat/mobile-approval-mode --oneline ^main
```

16 tasks, ~17 commits including one targeted security fix (Task 8 UPDATE scope) and one consistency fix (Task 3 expo-font tilde-pin). Branch is ready for merge once the simulator verification above lands clean.
