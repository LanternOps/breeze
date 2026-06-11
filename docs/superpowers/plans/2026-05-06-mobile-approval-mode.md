# Mobile Approval Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the mobile approval mode end-to-end — full-screen takeover for MCP step-up requests, with biometric, push delivery, offline cache, and a thin server contract — demoable on a physical iOS or Android device.

**Architecture:** Add a new `approval_requests` table (Shape 6, user-id scoped, RLS day-1) in the API, expose four mobile-prefixed routes (list, approve, deny, dev-seed) and a push dispatch service that hits Expo's Push API on insert. On the client (Expo SDK 55, RN 0.83, Reanimated 4.3, React 19), build a non-Paper approval surface: theme tokens (oklch → linear sRGB hex), Geist Sans + Mono via expo-font, custom motion + haptic utilities, a Redux slice + secure-store cache for offline reads, and a full-screen approval screen with countdown ring, mono details, risk band, biometric-gated approve, deny-with-reason, expiry, recursive 5s hold, and the entrance/success/deny/expiry animations from the design brief.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Postgres + RLS, Vitest (API), Expo SDK 55, React Native 0.83, React 19, Redux Toolkit 2.x, react-native-reanimated 4.3, expo-local-authentication, expo-notifications, expo-secure-store, expo-font, expo-haptics, Expo Push API.

**Brief:** [docs/superpowers/specs/2026-05-06-mobile-app-design-brief.md](../specs/2026-05-06-mobile-app-design-brief.md)

**Out of scope (explicit):**
- Hooking step-up into actual MCP tool enforcement (this plan delivers the approval surface; the system that *creates* approvals on real MCP tool calls is a follow-up).
- AI tab, Systems tab, Settings polish — phases 2 and 3.
- Multi-pending swipe (single approval at a time for v1).
- Light mode polish (dark canonical for v1; light tokens defined but not iterated).
- Reporting suspicious flow (UI link present, sheet content stubbed).
- Migrating the rest of the app (alerts/devices) off react-native-paper. Approval mode introduces a parallel non-Paper theme; existing screens keep Paper for now.

---

## File Structure

### New files (mobile)

| Path | Responsibility |
|---|---|
| `apps/mobile/src/theme/tokens.ts` | OKLCH-derived sRGB hex tokens, dark + light, status roles |
| `apps/mobile/src/theme/typography.ts` | Geist scale, weights, line-heights |
| `apps/mobile/src/theme/index.ts` | Barrel + `useApprovalTheme()` hook |
| `apps/mobile/assets/fonts/Geist-Regular.otf` | Bundled Geist Sans 400 |
| `apps/mobile/assets/fonts/Geist-Medium.otf` | 500 |
| `apps/mobile/assets/fonts/Geist-SemiBold.otf` | 600 |
| `apps/mobile/assets/fonts/GeistMono-Regular.otf` | Mono 400 |
| `apps/mobile/assets/fonts/GeistMono-Medium.otf` | Mono 500 |
| `apps/mobile/src/lib/motion.ts` | ease-out-quint utility, haptic wrappers, layout-safe animation helpers |
| `apps/mobile/src/lib/oklch.ts` | OKLCH→sRGB hex converter (compile-time only; tokens are pre-computed) |
| `apps/mobile/src/services/approvals.ts` | API client: list, approve, deny, report |
| `apps/mobile/src/services/approvalCache.ts` | secure-store cache for offline approval reads |
| `apps/mobile/src/store/approvalsSlice.ts` | Redux slice: pending list, current focus, optimistic decisions |
| `apps/mobile/src/screens/approvals/ApprovalScreen.tsx` | Full-screen takeover host |
| `apps/mobile/src/screens/approvals/components/CountdownRing.tsx` | SVG ring tied to expiry |
| `apps/mobile/src/screens/approvals/components/RequesterRow.tsx` | "Who's asking" |
| `apps/mobile/src/screens/approvals/components/ActionHeadline.tsx` | Display-size action |
| `apps/mobile/src/screens/approvals/components/DetailsCollapse.tsx` | Mono args, expandable |
| `apps/mobile/src/screens/approvals/components/RiskBand.tsx` | Tier color + summary |
| `apps/mobile/src/screens/approvals/components/ApprovalButtons.tsx` | Deny + Approve, biometric gating |
| `apps/mobile/src/screens/approvals/components/HoldToConfirm.tsx` | 5s hold for recursive approvals |
| `apps/mobile/src/screens/approvals/components/DenyReasonSheet.tsx` | Optional reason on deny |
| `apps/mobile/src/screens/approvals/components/ApprovalToast.tsx` | Post-decision toast |

### New files (api)

| Path | Responsibility |
|---|---|
| `apps/api/src/db/schema/approvals.ts` | Drizzle schema for `approval_requests` + risk tier + status enums |
| `apps/api/migrations/2026-05-06-approval-requests.sql` | Hand-written SQL: table + enums + indexes + RLS |
| `apps/api/src/routes/approvals.ts` | Mobile routes: list, get, approve, deny, dev-seed |
| `apps/api/src/routes/approvals.test.ts` | Vitest unit tests for routes (mocked db) |
| `apps/api/src/services/expoPush.ts` | Expo Push API client (HTTP POST to exp.host) |
| `apps/api/src/services/expoPush.test.ts` | Unit tests, mocked fetch |

### Modified files

| Path | Change |
|---|---|
| `apps/mobile/App.tsx` | Wrap with theme + font loader, register approval push handler |
| `apps/mobile/src/navigation/RootNavigator.tsx` | Mount `ApprovalScreen` as a global modal stack pre-empting MainNavigator when pending |
| `apps/mobile/src/services/notifications.ts` | Replace placeholder `'your-project-id'`; add `parseApprovalNotification` |
| `apps/mobile/src/services/api.ts` | Export approval client functions (or import from new module) |
| `apps/mobile/src/store/index.ts` | Wire approvals reducer |
| `apps/mobile/app.json` | Bundle fonts, set Expo project ID, configure notification sounds |
| `apps/mobile/package.json` | Add `expo-font`, `expo-haptics`, `react-native-svg` |
| `apps/api/src/db/schema/index.ts` | Re-export approvals schema |
| `apps/api/src/index.ts` | Mount approval routes |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | Add `approval_requests` to `USER_ID_SCOPED_TABLES` |

---

## Conventions

- **Commit style:** Match repo convention — `feat(mobile):`, `feat(api):`, `test(api):`, etc. Co-author trailer per CLAUDE.md.
- **Each task ends with a commit.** Frequent small commits over one big squash.
- **TDD where the project supports it:** API tasks use Vitest + Drizzle mocks (the project pattern). Mobile tasks have no test infrastructure and won't have one stood up in this phase — verification is typecheck + manual on-device. Tests for pure mobile logic (slice reducers, oklch conversion) are written inline as sanity checks via `node --test`-style in `__sanity__` files only when load-bearing.
- **Always run `pnpm typecheck` after every mobile task.** API: `npx tsc --noEmit`.

---

## Task 1: OKLCH→sRGB token table

**Files:**
- Create: `apps/mobile/src/lib/oklch.ts`
- Create: `apps/mobile/src/theme/tokens.ts`

OKLCH isn't supported in React Native styles. We pre-compute hex strings at design time and import them. The converter is committed so future token tweaks can be reproduced.

- [ ] **Step 1.1: Create `apps/mobile/src/lib/oklch.ts`**

```ts
// Minimal OKLCH → sRGB hex converter. Used at design time to derive token
// values committed in tokens.ts. Not used at runtime.
//
// Algorithm: OKLCH → OKLab → linear sRGB → gamma sRGB → hex.

export function oklchToHex(L: number, C: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const rLin =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  const toGamma = (v: number) => {
    const x = Math.max(0, Math.min(1, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };

  const r = Math.round(toGamma(rLin) * 255);
  const g = Math.round(toGamma(gLin) * 255);
  const bb = Math.round(toGamma(bLin) * 255);

  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(bb)}`;
}

export function oklchToRgba(L: number, C: number, hDeg: number, alpha: number): string {
  const hex = oklchToHex(L, C, hDeg);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
```

- [ ] **Step 1.2: Create `apps/mobile/src/theme/tokens.ts`**

Pre-computed values from oklch.ts. Comments document the source OKLCH so future tweaks are obvious.

```ts
// Brand: oklch(58% 0.13 200)  → cyan-leaning teal
// Approve: oklch(70% 0.18 145) → confident green
// Deny:    oklch(62% 0.22 25)  → earnest red
// Warning: oklch(78% 0.15 75)  → amber
// Surface dark: oklch(15% 0.012 200) → near-black tinted to brand
// Surface light: oklch(98% 0.005 200)
//
// Derived via lib/oklch.ts. Re-derive whenever you change a source value
// to keep this file authoritative.

export const palette = {
  brand: {
    base:    '#1c8a9e',  // oklch(58% 0.13 200)
    soft:    '#3eaec3',  // oklch(70% 0.10 200)
    deep:    '#0f5f6e',  // oklch(40% 0.08 200)
  },
  approve: {
    base:    '#2cb567',  // oklch(70% 0.18 145)
    wash:    'rgba(44,181,103,0.18)',
    onBase:  '#04230f',
  },
  deny: {
    base:    '#d94a3d',  // oklch(62% 0.22 25)
    wash:    'rgba(217,74,61,0.18)',
    onBase:  '#fff5f3',
  },
  warning: {
    base:    '#dba84a',  // oklch(78% 0.15 75)
    onBase:  '#241906',
  },
  // Tiered neutrals — chroma 0.012 toward brand hue, never #000/#fff.
  dark: {
    bg0:     '#0a1014',  // oklch(15% 0.012 200)
    bg1:     '#0f161b',
    bg2:     '#162026',
    bg3:     '#1f2c33',
    border:  '#2b3940',
    textHi:  '#eef4f6',
    textMd:  '#a8b8be',
    textLo:  '#6b7d83',
  },
  light: {
    bg0:     '#f9fbfb',  // oklch(98% 0.005 200)
    bg1:     '#f1f5f6',
    bg2:     '#e6ecee',
    bg3:     '#d8e0e3',
    border:  '#bfc9cd',
    textHi:  '#0a1014',
    textMd:  '#3a484e',
    textLo:  '#6b7d83',
  },
} as const;

// Risk tier → band color
export const riskTier = {
  low:      { band: palette.brand.deep,  text: palette.dark.textHi },
  medium:   { band: palette.warning.base, text: palette.warning.onBase },
  high:     { band: palette.deny.base,    text: palette.deny.onBase },
  critical: { band: '#7a1d18',            text: '#fff5f3' },
} as const;

export type RiskTier = keyof typeof riskTier;

export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  full: 999,
} as const;

export const spacing = {
  px: 1,
  '0.5': 2,
  '1': 4,
  '2': 8,
  '3': 12,
  '4': 16,
  '5': 20,
  '6': 24,
  '8': 32,
  '10': 40,
  '12': 48,
  '16': 64,
  '20': 80,
} as const;
```

- [ ] **Step 1.3: Verify typecheck**

Run: `cd apps/mobile && pnpm typecheck`
Expected: PASS, no new errors.

- [ ] **Step 1.4: Commit**

```bash
git add apps/mobile/src/lib/oklch.ts apps/mobile/src/theme/tokens.ts
git commit -m "$(cat <<'EOF'
feat(mobile): add OKLCH-derived theme tokens for approval mode

Introduces a non-Paper token system: brand teal, approve/deny/warning
status colors, tinted dark + light neutrals, risk tier bands, radii and
spacing scale. Values are pre-computed from OKLCH via lib/oklch.ts so
future tweaks are reproducible.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Typography scale

**Files:**
- Create: `apps/mobile/src/theme/typography.ts`

- [ ] **Step 2.1: Create the file**

```ts
import type { TextStyle } from 'react-native';

// Geist family. Weights are loaded via expo-font; family names below match
// the registration in App.tsx (next task).
export const fontFamily = {
  sans:        'Geist-Regular',
  sansMedium:  'Geist-Medium',
  sansSemiBold:'Geist-SemiBold',
  mono:        'GeistMono-Regular',
  monoMedium:  'GeistMono-Medium',
} as const;

type StyleStep = Pick<TextStyle, 'fontFamily' | 'fontSize' | 'lineHeight' | 'letterSpacing'>;

export const type = {
  display:   { fontFamily: fontFamily.sansSemiBold, fontSize: 32, lineHeight: 36, letterSpacing: -0.4 } satisfies StyleStep,
  title:     { fontFamily: fontFamily.sansSemiBold, fontSize: 22, lineHeight: 28, letterSpacing: -0.2 } satisfies StyleStep,
  bodyLg:    { fontFamily: fontFamily.sans,        fontSize: 17, lineHeight: 24 } satisfies StyleStep,
  body:      { fontFamily: fontFamily.sans,        fontSize: 16, lineHeight: 24 } satisfies StyleStep,
  bodyMd:    { fontFamily: fontFamily.sansMedium,  fontSize: 16, lineHeight: 24 } satisfies StyleStep,
  meta:      { fontFamily: fontFamily.sansMedium,  fontSize: 13, lineHeight: 18, letterSpacing: 0.1 } satisfies StyleStep,
  metaCaps:  { fontFamily: fontFamily.sansSemiBold,fontSize: 11, lineHeight: 14, letterSpacing: 1.0 } satisfies StyleStep,
  mono:      { fontFamily: fontFamily.mono,        fontSize: 14, lineHeight: 22 } satisfies StyleStep,
  monoMd:    { fontFamily: fontFamily.monoMedium,  fontSize: 14, lineHeight: 22 } satisfies StyleStep,
};
```

- [ ] **Step 2.2: Verify typecheck**

Run: `cd apps/mobile && pnpm typecheck`
Expected: PASS.

- [ ] **Step 2.3: Commit**

```bash
git add apps/mobile/src/theme/typography.ts
git commit -m "$(cat <<'EOF'
feat(mobile): add Geist typography scale for approval mode

Defines display/title/body/meta/mono steps with Geist family registrations
referenced by name. Font loading wired in next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Bundle Geist fonts

**Files:**
- Add binary: `apps/mobile/assets/fonts/{Geist-Regular,Geist-Medium,Geist-SemiBold,GeistMono-Regular,GeistMono-Medium}.otf`
- Modify: `apps/mobile/package.json` (add `expo-font`)
- Modify: `apps/mobile/App.tsx` (load fonts, gate render)
- Create: `apps/mobile/src/theme/index.ts`

Geist is OFL — bundling in a published app is permitted. Source: https://github.com/vercel/geist-font (Variable + static OTFs).

- [ ] **Step 3.1: Download Geist statics**

Run from repo root:
```bash
mkdir -p apps/mobile/assets/fonts
curl -L -o /tmp/geist.zip https://github.com/vercel/geist-font/releases/latest/download/geist-font.zip
unzip -o /tmp/geist.zip -d /tmp/geist
cp /tmp/geist/Geist/static/Geist-{Regular,Medium,SemiBold}.otf apps/mobile/assets/fonts/
cp /tmp/geist/GeistMono/static/GeistMono-{Regular,Medium}.otf apps/mobile/assets/fonts/
ls apps/mobile/assets/fonts/
```

Expected: 5 .otf files listed. If the release URL has changed, fall back to: https://vercel.com/font (download Geist + Geist Mono) and copy the same five static OTFs into the same folder.

- [ ] **Step 3.2: Add `expo-font`**

```bash
cd apps/mobile && pnpm add expo-font
```

Verify the version installed matches Expo SDK 55 expectations (~13.x).

- [ ] **Step 3.3: Create `apps/mobile/src/theme/index.ts`**

```ts
export * from './tokens';
export * from './typography';

import { useColorScheme } from 'react-native';
import { palette } from './tokens';

// Approval mode is dark-canonical. This hook returns the right palette half
// for the current scheme but consumers can pass `force: 'dark' | 'light'`
// to lock the scheme — approval mode always passes 'dark'.
export function useApprovalTheme(force?: 'dark' | 'light') {
  const scheme = useColorScheme();
  const mode = force ?? (scheme === 'light' ? 'light' : 'dark');
  return {
    mode,
    bg0: palette[mode].bg0,
    bg1: palette[mode].bg1,
    bg2: palette[mode].bg2,
    bg3: palette[mode].bg3,
    border: palette[mode].border,
    textHi: palette[mode].textHi,
    textMd: palette[mode].textMd,
    textLo: palette[mode].textLo,
    brand: palette.brand.base,
    approve: palette.approve.base,
    deny: palette.deny.base,
    warning: palette.warning.base,
  };
}
```

- [ ] **Step 3.4: Modify `apps/mobile/App.tsx` to load fonts**

Replace the existing component definition. Add font loader and gate render until ready.

```tsx
import { useEffect, useState } from 'react';
import * as Font from 'expo-font';
import { ActivityIndicator, View, useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Provider as ReduxProvider } from 'react-redux';
import { Provider as PaperProvider, MD3DarkTheme, MD3LightTheme } from 'react-native-paper';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { store } from './src/store';
import { RootNavigator } from './src/navigation/RootNavigator';
import { registerForPushNotifications } from './src/services/notifications';
import { palette } from './src/theme';

// existing customLightTheme / customDarkTheme stay as-is for the rest of
// the app — approval mode does NOT use Paper.

export default function App() {
  const colorScheme = useColorScheme();
  const theme = colorScheme === 'dark' ? customDarkTheme : customLightTheme;
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    Font.loadAsync({
      'Geist-Regular':     require('./assets/fonts/Geist-Regular.otf'),
      'Geist-Medium':      require('./assets/fonts/Geist-Medium.otf'),
      'Geist-SemiBold':    require('./assets/fonts/Geist-SemiBold.otf'),
      'GeistMono-Regular': require('./assets/fonts/GeistMono-Regular.otf'),
      'GeistMono-Medium':  require('./assets/fonts/GeistMono-Medium.otf'),
    })
      .catch((err) => console.warn('Font load failed:', err))
      .finally(() => setFontsReady(true));
  }, []);

  useEffect(() => {
    registerForPushNotifications();
  }, []);

  if (!fontsReady) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: palette.dark.bg0 }}>
        <ActivityIndicator color={palette.brand.base} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ReduxProvider store={store}>
          <PaperProvider theme={theme}>
            <RootNavigator />
            <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
          </PaperProvider>
        </ReduxProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

- [ ] **Step 3.5: Verify on device**

```bash
cd apps/mobile && pnpm start
```

Open on iOS simulator or physical device. Expected: app loads past the spinner; existing screens still render with Paper. No font load warnings in Metro.

- [ ] **Step 3.6: Commit**

```bash
git add apps/mobile/assets/fonts apps/mobile/package.json apps/mobile/pnpm-lock.yaml apps/mobile/App.tsx apps/mobile/src/theme/index.ts
git commit -m "$(cat <<'EOF'
feat(mobile): bundle Geist + Geist Mono and gate App on font load

Adds expo-font, ships static OTFs (OFL-licensed), loads them at boot, and
exposes useApprovalTheme() returning the right palette half. Existing Paper
theme is untouched — approval mode is the only consumer of the new theme.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Motion + haptic utilities

**Files:**
- Modify: `apps/mobile/package.json` (add `expo-haptics`)
- Create: `apps/mobile/src/lib/motion.ts`

- [ ] **Step 4.1: Add `expo-haptics`**

```bash
cd apps/mobile && pnpm add expo-haptics
```

- [ ] **Step 4.2: Create `apps/mobile/src/lib/motion.ts`**

```ts
import { Easing } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

// Single ease curve everywhere. ease-out-quint is calm and confident at
// medium durations (200–400ms). No bounce, no elastic.
export const ease = Easing.bezier(0.22, 1, 0.36, 1);

// Durations in ms. Keep this small set — variance is in the curve, not in
// the speed.
export const duration = {
  fast: 180,    // tab fade, small state changes
  base: 240,    // most transitions
  swell: 320,   // success wash, card lift
  enter: 400,   // approval entrance
  exit: 280,    // approval dismiss
} as const;

export const haptic = {
  // Approval entrance: a soft buzz, not a startle.
  arrive: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft),
  // Approve confirmed.
  approve: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  // Deny: sharper but not warning-tier.
  deny: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  // Biometric prompt cancel / generic feedback.
  tap: () => Haptics.selectionAsync(),
  // Recursive hold completes.
  hold: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  // Expiry — no haptic, intentional silence.
};
```

- [ ] **Step 4.3: Verify typecheck**

Run: `cd apps/mobile && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4.4: Commit**

```bash
git add apps/mobile/package.json apps/mobile/pnpm-lock.yaml apps/mobile/src/lib/motion.ts
git commit -m "$(cat <<'EOF'
feat(mobile): add motion + haptic utilities for approval mode

Single ease-out-quint curve, fixed duration ladder, named haptics for the
five approval moments (arrive, approve, deny, hold, tap). Expiry is
intentionally silent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: API — `approval_requests` schema (Drizzle)

**Files:**
- Create: `apps/api/src/db/schema/approvals.ts`
- Modify: `apps/api/src/db/schema/index.ts`

Tenancy shape: **Shape 6 (User-id scoped)** per CLAUDE.md. Each request belongs to exactly one user (the approver).

- [ ] **Step 5.1: Create `apps/api/src/db/schema/approvals.ts`**

```ts
import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { oauthClients, oauthSessions } from './oauth';

export const approvalRiskTierEnum = pgEnum('approval_risk_tier', [
  'low',
  'medium',
  'high',
  'critical',
]);

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'denied',
  'expired',
  'reported',
]);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

    // Who's asking
    requestingClientId: uuid('requesting_client_id').references(() => oauthClients.id),
    requestingSessionId: uuid('requesting_session_id').references(() => oauthSessions.id),
    requestingClientLabel: varchar('requesting_client_label', { length: 255 }).notNull(),
    requestingMachineLabel: varchar('requesting_machine_label', { length: 255 }),

    // What
    actionLabel: text('action_label').notNull(),
    actionToolName: varchar('action_tool_name', { length: 255 }).notNull(),
    actionArguments: jsonb('action_arguments').notNull().default({}),

    // Risk
    riskTier: approvalRiskTierEnum('risk_tier').notNull(),
    riskSummary: text('risk_summary').notNull(),

    // Lifecycle
    status: approvalStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userPendingIdx: index('approval_requests_user_pending_idx').on(t.userId, t.status, t.expiresAt),
    createdAtIdx: index('approval_requests_created_at_idx').on(t.createdAt),
  })
);

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type NewApprovalRequest = typeof approvalRequests.$inferInsert;
```

- [ ] **Step 5.2: Re-export from `apps/api/src/db/schema/index.ts`**

Append:
```ts
export * from './approvals';
```

- [ ] **Step 5.3: Verify typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: PASS, no new errors. Pre-existing errors in `agents.test.ts` and `apiKeyAuth.test.ts` are known per memory.

- [ ] **Step 5.4: Commit**

```bash
git add apps/api/src/db/schema/approvals.ts apps/api/src/db/schema/index.ts
git commit -m "$(cat <<'EOF'
feat(api): add approval_requests schema (mobile step-up)

User-scoped table for MCP step-up + future PAM approval requests. Captures
requesting OAuth client/session, plain-English action, mono tool name +
JSON args, risk tier, lifecycle status, and explicit expiry. RLS policies
land in the migration in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: API — migration with RLS

**Files:**
- Create: `apps/api/migrations/2026-05-06-approval-requests.sql`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (add to `USER_ID_SCOPED_TABLES`)

- [ ] **Step 6.1: Create the migration**

```sql
-- 2026-05-06-approval-requests.sql
-- approval_requests: user-id scoped (Shape 6).

DO $$ BEGIN
  CREATE TYPE approval_risk_tier AS ENUM ('low','medium','high','critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE approval_status AS ENUM ('pending','approved','denied','expired','reported');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requesting_client_id uuid REFERENCES oauth_clients(id),
  requesting_session_id uuid REFERENCES oauth_sessions(id),
  requesting_client_label varchar(255) NOT NULL,
  requesting_machine_label varchar(255),
  action_label text NOT NULL,
  action_tool_name varchar(255) NOT NULL,
  action_arguments jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_tier approval_risk_tier NOT NULL,
  risk_summary text NOT NULL,
  status approval_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approval_requests_user_pending_idx
  ON approval_requests (user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS approval_requests_created_at_idx
  ON approval_requests (created_at);

-- RLS: enable + force, then policy.
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'approval_requests'
      AND policyname = 'approval_requests_user_scope'
  ) THEN
    CREATE POLICY approval_requests_user_scope ON approval_requests
      USING (user_id = breeze_current_user_id())
      WITH CHECK (user_id = breeze_current_user_id());
  END IF;
END $$;
```

- [ ] **Step 6.2: Add to RLS coverage allowlist**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, find the `USER_ID_SCOPED_TABLES` `Set` and add `'approval_requests'`:

```ts
const USER_ID_SCOPED_TABLES: ReadonlySet<string> = new Set<string>([
  // ... existing entries
  'approval_requests',
]);
```

- [ ] **Step 6.3: Apply migration locally**

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up -d postgres
cd apps/api && pnpm db:migrate || npx tsx src/db/autoMigrate.ts
```

Expected: migration applies cleanly. Re-running is a no-op.

- [ ] **Step 6.4: Manually verify RLS forbids cross-user reads**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
```

Then:
```sql
-- Without context, RLS should hide everything.
SELECT count(*) FROM approval_requests;
-- Expected: 0 (or error if no SELECT — acceptable either way for the contract)

-- Forging an insert without context should fail.
INSERT INTO approval_requests
  (user_id, requesting_client_label, action_label, action_tool_name, risk_tier, risk_summary, expires_at)
VALUES (gen_random_uuid(), 'forged', 'forged', 'forged', 'low', 'forged', now() + interval '1 minute');
-- Expected: ERROR: new row violates row-level security policy for table "approval_requests"
```

- [ ] **Step 6.5: Run RLS coverage contract test**

```bash
cd apps/api && pnpm test:rls
```

Expected: PASS, including the new entry.

- [ ] **Step 6.6: Commit**

```bash
git add apps/api/migrations/2026-05-06-approval-requests.sql apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(api): migrate approval_requests + RLS user-scoped policy

Idempotent migration creates the enums, table, indexes, and a Shape-6 RLS
policy keyed on breeze_current_user_id(). Adds the table to
USER_ID_SCOPED_TABLES so the coverage contract test passes.

Verified as breeze_app: forged cross-user inserts are rejected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: API — Expo Push dispatcher

**Files:**
- Create: `apps/api/src/services/expoPush.ts`
- Create: `apps/api/src/services/expoPush.test.ts`

Expo Push API: `POST https://exp.host/--/api/v2/push/send`. Tokens look like `ExponentPushToken[xxx]`. We use Expo's hosted push — no APNs/FCM setup for v1. The mobile already requests Expo tokens via `getExpoPushTokenAsync`. Pre-existing schema mismatch (`fcm_token`/`apns_token` columns hold Expo tokens in practice) is preserved; we read from whichever column matches the platform.

- [ ] **Step 7.1: Create `apps/api/src/services/expoPush.ts`**

```ts
import { db } from '../db';
import { mobileDevices } from '../db/schema/mobile';
import { and, eq, isNotNull } from 'drizzle-orm';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;
  ttl?: number;
}

export interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export async function sendExpoPush(
  messages: ExpoPushMessage[]
): Promise<ExpoPushTicket[]> {
  if (messages.length === 0) return [];
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
    },
    body: JSON.stringify(messages),
  });
  if (!res.ok) {
    throw new Error(`Expo push failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { data: ExpoPushTicket[] };
  return json.data;
}

// Fetch every active push token registered to a user (across both columns).
export async function getUserPushTokens(userId: string): Promise<string[]> {
  const rows = await db
    .select({
      fcm: mobileDevices.fcmToken,
      apns: mobileDevices.apnsToken,
    })
    .from(mobileDevices)
    .where(and(eq(mobileDevices.userId, userId), eq(mobileDevices.notificationsEnabled, true)));
  return rows
    .flatMap((r) => [r.fcm, r.apns])
    .filter((t): t is string => !!t && t.startsWith('ExponentPushToken'));
}

// Build the lock-screen payload for an approval. Per Q1 in the brief: only
// the action verb + org name, never arguments. Full details require unlock.
export function buildApprovalPush(args: {
  approvalId: string;
  actionLabel: string;
  requestingClientLabel: string;
}): Pick<ExpoPushMessage, 'title' | 'body' | 'data' | 'sound' | 'priority' | 'channelId' | 'ttl'> {
  return {
    title: 'Approval requested',
    body: `${args.requestingClientLabel}: ${args.actionLabel}`,
    data: { type: 'approval', approvalId: args.approvalId },
    sound: 'default',
    priority: 'high',
    channelId: 'approvals',
    ttl: 60,
  };
}
```

- [ ] **Step 7.2: Write the tests first**

Create `apps/api/src/services/expoPush.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendExpoPush, buildApprovalPush } from './expoPush';

describe('buildApprovalPush', () => {
  it('limits the body to client label + action label only', () => {
    const msg = buildApprovalPush({
      approvalId: 'a1',
      actionLabel: 'Delete 4 devices in Acme Corp',
      requestingClientLabel: 'Claude Desktop',
    });
    expect(msg.title).toBe('Approval requested');
    expect(msg.body).toBe('Claude Desktop: Delete 4 devices in Acme Corp');
    expect(msg.data).toEqual({ type: 'approval', approvalId: 'a1' });
    expect(msg.priority).toBe('high');
    expect(msg.ttl).toBe(60);
  });
});

describe('sendExpoPush', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns [] when given no messages without hitting the network', async () => {
    const tickets = await sendExpoPush([]);
    expect(tickets).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POSTs to the Expo Push endpoint and returns tickets', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok', id: 'tk1' }] }),
    } as unknown as Response);

    const tickets = await sendExpoPush([
      { to: 'ExponentPushToken[abc]', title: 't', body: 'b' },
    ]);
    expect(tickets).toEqual([{ status: 'ok', id: 'tk1' }]);
    expect(fetch).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws when Expo returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'oops',
    } as unknown as Response);
    await expect(
      sendExpoPush([{ to: 'ExponentPushToken[abc]', title: 't', body: 'b' }])
    ).rejects.toThrow(/Expo push failed: 500/);
  });
});
```

- [ ] **Step 7.3: Run tests**

```bash
cd apps/api && pnpm test src/services/expoPush.test.ts
```
Expected: PASS.

- [ ] **Step 7.4: Commit**

```bash
git add apps/api/src/services/expoPush.ts apps/api/src/services/expoPush.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add Expo Push dispatcher for approval notifications

Thin client over exp.host's Push API plus helpers for token lookup and
constructing the approval payload (action verb + client label only — never
arguments on the lock screen). Reads Expo tokens from the existing
fcm_token/apns_token columns on mobile_devices.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: API — approval routes

**Files:**
- Create: `apps/api/src/routes/approvals.ts`
- Create: `apps/api/src/routes/approvals.test.ts`
- Modify: `apps/api/src/index.ts` (mount route)

Routes (all under `/api/v1/mobile/approvals`, JWT auth required):

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/pending`     | List pending approvals for the authed user |
| `GET`  | `/:id`         | Fetch one approval (full detail) |
| `POST` | `/:id/approve` | Approve (server verifies pending + not expired) |
| `POST` | `/:id/deny`    | Deny (optional reason) |
| `POST` | `/dev/seed`    | DEV ONLY — create a fake approval for testing. 404 in prod. |

- [ ] **Step 8.1: Write the failing test**

Create `apps/api/src/routes/approvals.test.ts`. Follow the project's existing route-test pattern (Drizzle mocks, Hono `app.request`). Reference: `apps/api/src/routes/incidents.test.ts`.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Hoisted mocks
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../services/expoPush', () => ({
  sendExpoPush: vi.fn(async () => [{ status: 'ok', id: 'tk' }]),
  getUserPushTokens: vi.fn(async () => ['ExponentPushToken[abc]']),
  buildApprovalPush: vi.fn(() => ({
    title: 'Approval requested',
    body: 'x: y',
    data: { type: 'approval', approvalId: 'a1' },
  })),
}));

const TEST_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 't@example.com',
  partnerId: 'p1',
  orgId: null,
};

vi.mock('../middleware/auth', () => ({
  authMiddleware: () => async (c: { set: (k: string, v: unknown) => void; req: unknown }, next: () => Promise<void>) => {
    (c as unknown as { set: (k: string, v: unknown) => void }).set('auth', { user: TEST_USER });
    await next();
  },
}));

import { approvalRoutes } from './approvals';
import { db } from '../db';

function buildApp() {
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /approvals/pending', () => {
  it('returns only pending non-expired approvals for the authed user', async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([
            {
              id: 'a1',
              userId: TEST_USER.id,
              requestingClientLabel: 'Claude Desktop',
              actionLabel: 'Delete 4 devices in Acme Corp',
              actionToolName: 'breeze.devices.delete',
              actionArguments: { ids: ['x'] },
              riskTier: 'high',
              riskSummary: 'High impact: deletes data.',
              status: 'pending',
              expiresAt: new Date(Date.now() + 60_000),
              createdAt: new Date(),
              requestingMachineLabel: "Todd's MacBook Pro",
              requestingClientId: null,
              requestingSessionId: null,
              decidedAt: null,
              decisionReason: null,
            },
          ]),
        }),
      }),
    });

    const res = await buildApp().request('/approvals/pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].id).toBe('a1');
  });
});

describe('POST /approvals/:id/approve', () => {
  it('rejects when the approval is already decided', async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{
          id: 'a1', userId: TEST_USER.id, status: 'denied',
          expiresAt: new Date(Date.now() + 60_000),
        }]),
      }),
    });

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('rejects when the approval has expired', async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{
          id: 'a1', userId: TEST_USER.id, status: 'pending',
          expiresAt: new Date(Date.now() - 1000),
        }]),
      }),
    });
    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(410);
  });

  it('updates status to approved when valid', async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{
          id: 'a1', userId: TEST_USER.id, status: 'pending',
          expiresAt: new Date(Date.now() + 60_000),
        }]),
      }),
    });
    const updateReturning = vi.fn().mockResolvedValue([{ id: 'a1', status: 'approved' }]);
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue({
      set: () => ({ where: () => ({ returning: updateReturning }) }),
    });

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(updateReturning).toHaveBeenCalled();
  });
});

describe('POST /approvals/dev/seed', () => {
  it('returns 404 when NODE_ENV=production', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await buildApp().request('/approvals/dev/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionLabel: 'x', actionToolName: 'y', riskTier: 'low', riskSummary: 'z' }),
      });
      expect(res.status).toBe(404);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});
```

- [ ] **Step 8.2: Run tests to confirm they fail**

```bash
cd apps/api && pnpm test src/routes/approvals.test.ts
```
Expected: FAIL — "Cannot find module './approvals'".

- [ ] **Step 8.3: Implement the routes**

Create `apps/api/src/routes/approvals.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gt, desc } from 'drizzle-orm';
import type { Context } from 'hono';

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { approvalRequests } from '../db/schema/approvals';
import { buildApprovalPush, getUserPushTokens, sendExpoPush } from '../services/expoPush';

type AuthVars = { auth: { user: { id: string; email: string; partnerId?: string | null; orgId?: string | null } } };

export const approvalRoutes = new Hono<{ Variables: AuthVars }>();

approvalRoutes.use('*', authMiddleware());

// ─────────────────────────────────────────────────────────────────────────
// GET /pending
// ─────────────────────────────────────────────────────────────────────────
approvalRoutes.get('/pending', async (c) => {
  const userId = c.get('auth').user.id;
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.userId, userId),
        eq(approvalRequests.status, 'pending'),
        gt(approvalRequests.expiresAt, new Date()),
      )
    )
    .orderBy(desc(approvalRequests.createdAt));

  return c.json({ approvals: rows.map(serialize) });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id
// ─────────────────────────────────────────────────────────────────────────
approvalRoutes.get('/:id', async (c) => {
  const userId = c.get('auth').user.id;
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ approval: serialize(row) });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/approve
// ─────────────────────────────────────────────────────────────────────────
approvalRoutes.post('/:id/approve', async (c) => {
  return decideHandler(c, 'approved');
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/deny
// ─────────────────────────────────────────────────────────────────────────
const denySchema = z.object({ reason: z.string().max(500).optional() });

approvalRoutes.post('/:id/deny', zValidator('json', denySchema), async (c) => {
  const reason = c.req.valid('json').reason;
  return decideHandler(c, 'denied', reason);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /dev/seed (dev-only)
// ─────────────────────────────────────────────────────────────────────────
const seedSchema = z.object({
  actionLabel: z.string().min(1).max(500),
  actionToolName: z.string().min(1).max(255),
  actionArguments: z.record(z.unknown()).optional(),
  riskTier: z.enum(['low', 'medium', 'high', 'critical']),
  riskSummary: z.string().min(1).max(500),
  requestingClientLabel: z.string().min(1).max(255).optional(),
  requestingMachineLabel: z.string().max(255).optional(),
  expiresInSeconds: z.number().int().min(10).max(3600).optional(),
});

approvalRoutes.post('/dev/seed', zValidator('json', seedSchema), async (c) => {
  if (process.env.NODE_ENV === 'production') return c.json({ error: 'Not found' }, 404);

  const userId = c.get('auth').user.id;
  const body = c.req.valid('json');
  const expiresAt = new Date(Date.now() + (body.expiresInSeconds ?? 60) * 1000);

  const [row] = await db
    .insert(approvalRequests)
    .values({
      userId,
      requestingClientLabel: body.requestingClientLabel ?? 'Dev Seed',
      requestingMachineLabel: body.requestingMachineLabel ?? null,
      actionLabel: body.actionLabel,
      actionToolName: body.actionToolName,
      actionArguments: body.actionArguments ?? {},
      riskTier: body.riskTier,
      riskSummary: body.riskSummary,
      status: 'pending',
      expiresAt,
    })
    .returning();

  // Fire push (non-blocking on errors so dev seeding still works without a token).
  try {
    const tokens = await getUserPushTokens(userId);
    if (tokens.length > 0) {
      await sendExpoPush(
        tokens.map((to) => ({
          to,
          ...buildApprovalPush({
            approvalId: row.id,
            actionLabel: row.actionLabel,
            requestingClientLabel: row.requestingClientLabel,
          }),
        }))
      );
    }
  } catch (err) {
    console.warn('[approvals.dev/seed] push dispatch failed', err);
  }

  return c.json({ approval: serialize(row) }, 201);
});

// ─────────────────────────────────────────────────────────────────────────
// Shared decide handler
// ─────────────────────────────────────────────────────────────────────────
async function decideHandler(c: Context<{ Variables: AuthVars }>, status: 'approved' | 'denied', reason?: string) {
  const userId = c.get('auth').user.id;
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));

  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.status !== 'pending') return c.json({ error: `Already ${row.status}` }, 409);
  if (row.expiresAt.getTime() <= Date.now()) return c.json({ error: 'Expired' }, 410);

  const [updated] = await db
    .update(approvalRequests)
    .set({ status, decidedAt: new Date(), decisionReason: reason ?? null })
    .where(eq(approvalRequests.id, id))
    .returning();

  return c.json({ approval: serialize(updated) });
}

// ─────────────────────────────────────────────────────────────────────────
function serialize(r: typeof approvalRequests.$inferSelect) {
  return {
    id: r.id,
    requestingClientLabel: r.requestingClientLabel,
    requestingMachineLabel: r.requestingMachineLabel,
    actionLabel: r.actionLabel,
    actionToolName: r.actionToolName,
    actionArguments: r.actionArguments,
    riskTier: r.riskTier,
    riskSummary: r.riskSummary,
    status: r.status,
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionReason: r.decisionReason,
    createdAt: r.createdAt.toISOString(),
  };
}
```

- [ ] **Step 8.4: Mount in `apps/api/src/index.ts`**

Find the existing route mounts (`app.route('/api/v1/mobile/...', ...)`) and add:

```ts
import { approvalRoutes } from './routes/approvals';
// ...
app.route('/api/v1/mobile/approvals', approvalRoutes);
```

- [ ] **Step 8.5: Run tests**

```bash
cd apps/api && pnpm test src/routes/approvals.test.ts
```
Expected: PASS.

- [ ] **Step 8.6: Smoke-test the dev/seed endpoint**

With local API running:
```bash
TOKEN="<a valid JWT>"
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
    "requestingMachineLabel": "Todd'\''s MacBook Pro",
    "expiresInSeconds": 60
  }'
```
Expected: 201 with the serialized approval.

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/mobile/approvals/pending
```
Expected: 200 with the approval in the list.

- [ ] **Step 8.7: Commit**

```bash
git add apps/api/src/routes/approvals.ts apps/api/src/routes/approvals.test.ts apps/api/src/index.ts
git commit -m "$(cat <<'EOF'
feat(api): add mobile approval routes (list/get/approve/deny + dev seed)

GET /pending and GET /:id, POST /:id/approve and POST /:id/deny with
status/expiry guards (409 already-decided, 410 expired). Adds a dev-only
POST /dev/seed for end-to-end testing without MCP wiring; the seed handler
also dispatches an Expo push to the requesting user's registered tokens.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Mobile — approval API client + cache

**Files:**
- Create: `apps/mobile/src/services/approvals.ts`
- Create: `apps/mobile/src/services/approvalCache.ts`

- [ ] **Step 9.1: Create `apps/mobile/src/services/approvals.ts`**

Reuse the project's existing fetch wrapper pattern in `services/api.ts`. Add:

```ts
import * as SecureStore from 'expo-secure-store';
import { getServerUrl } from './serverConfig';

const PREFIX = '/api/v1/mobile/approvals';
const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_HEADER_VALUE = '1';

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'reported';

export interface ApprovalRequest {
  id: string;
  requestingClientLabel: string;
  requestingMachineLabel: string | null;
  actionLabel: string;
  actionToolName: string;
  actionArguments: Record<string, unknown>;
  riskTier: RiskTier;
  riskSummary: string;
  status: ApprovalStatus;
  expiresAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
}

async function authedFetch(path: string, init?: RequestInit) {
  const token = await SecureStore.getItemAsync('auth_token');
  const baseUrl = await getServerUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      ...(init?.headers ?? {}),
    },
  });
  return res;
}

export async function fetchPendingApprovals(): Promise<ApprovalRequest[]> {
  const res = await authedFetch(`${PREFIX}/pending`);
  if (!res.ok) throw new Error(`Failed to fetch approvals: ${res.status}`);
  const json = await res.json();
  return json.approvals;
}

export async function fetchApproval(id: string): Promise<ApprovalRequest> {
  const res = await authedFetch(`${PREFIX}/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch approval: ${res.status}`);
  const json = await res.json();
  return json.approval;
}

export async function approveRequest(id: string): Promise<ApprovalRequest> {
  const res = await authedFetch(`${PREFIX}/${id}/approve`, { method: 'POST' });
  if (res.status === 409) throw new Error('ALREADY_DECIDED');
  if (res.status === 410) throw new Error('EXPIRED');
  if (!res.ok) throw new Error(`Approve failed: ${res.status}`);
  const json = await res.json();
  return json.approval;
}

export async function denyRequest(id: string, reason?: string): Promise<ApprovalRequest> {
  const res = await authedFetch(`${PREFIX}/${id}/deny`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  if (res.status === 409) throw new Error('ALREADY_DECIDED');
  if (res.status === 410) throw new Error('EXPIRED');
  if (!res.ok) throw new Error(`Deny failed: ${res.status}`);
  const json = await res.json();
  return json.approval;
}
```

- [ ] **Step 9.2: Create `apps/mobile/src/services/approvalCache.ts`**

```ts
import * as SecureStore from 'expo-secure-store';
import type { ApprovalRequest } from './approvals';

const KEY = 'breeze.approvals.cache.v1';

// Brief promise: "approvals work offline if already delivered."
// Cache the most recent /pending response so a cold open with no network
// can still render the queue.

export async function readCachedApprovals(): Promise<ApprovalRequest[]> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ApprovalRequest[];
    return parsed.filter((a) => new Date(a.expiresAt).getTime() > Date.now());
  } catch {
    return [];
  }
}

export async function writeCachedApprovals(approvals: ApprovalRequest[]): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(approvals));
  } catch (err) {
    console.warn('[approvalCache] write failed', err);
  }
}

export async function clearCachedApproval(id: string): Promise<void> {
  const cached = await readCachedApprovals();
  await writeCachedApprovals(cached.filter((a) => a.id !== id));
}
```

- [ ] **Step 9.3: Verify typecheck**

```bash
cd apps/mobile && pnpm typecheck
```
Expected: PASS.

- [ ] **Step 9.4: Commit**

```bash
git add apps/mobile/src/services/approvals.ts apps/mobile/src/services/approvalCache.ts
git commit -m "$(cat <<'EOF'
feat(mobile): add approval API client + secure-store cache

Five HTTP methods (list pending, fetch one, approve, deny) with explicit
ALREADY_DECIDED / EXPIRED error codes consumers can branch on. Cache
encrypts pending approvals at rest and filters expired entries on read so
offline cold opens render only the still-actionable queue.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Mobile — Redux slice

**Files:**
- Create: `apps/mobile/src/store/approvalsSlice.ts`
- Modify: `apps/mobile/src/store/index.ts`

- [ ] **Step 10.1: Create the slice**

```ts
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  type ApprovalRequest,
  approveRequest as apiApprove,
  denyRequest as apiDeny,
  fetchApproval as apiFetchOne,
  fetchPendingApprovals as apiFetchPending,
} from '../services/approvals';
import { readCachedApprovals, writeCachedApprovals, clearCachedApproval } from '../services/approvalCache';

interface ApprovalsState {
  pending: ApprovalRequest[];
  focusId: string | null;
  loading: boolean;
  error: string | null;
  decisionInFlight: Record<string, 'approve' | 'deny' | undefined>;
}

const initialState: ApprovalsState = {
  pending: [],
  focusId: null,
  loading: false,
  error: null,
  decisionInFlight: {},
};

export const hydrateFromCache = createAsyncThunk('approvals/hydrate', async () => {
  return await readCachedApprovals();
});

export const refreshPending = createAsyncThunk('approvals/refresh', async () => {
  const list = await apiFetchPending();
  await writeCachedApprovals(list);
  return list;
});

export const fetchOne = createAsyncThunk('approvals/fetchOne', async (id: string) => {
  return await apiFetchOne(id);
});

export const approve = createAsyncThunk('approvals/approve', async (id: string) => {
  const updated = await apiApprove(id);
  await clearCachedApproval(id);
  return updated;
});

export const deny = createAsyncThunk(
  'approvals/deny',
  async (args: { id: string; reason?: string }) => {
    const updated = await apiDeny(args.id, args.reason);
    await clearCachedApproval(args.id);
    return updated;
  }
);

const slice = createSlice({
  name: 'approvals',
  initialState,
  reducers: {
    setFocus(state, action: PayloadAction<string | null>) {
      state.focusId = action.payload;
    },
    markExpired(state, action: PayloadAction<string>) {
      const i = state.pending.findIndex((a) => a.id === action.payload);
      if (i >= 0) state.pending[i].status = 'expired';
    },
    upsert(state, action: PayloadAction<ApprovalRequest>) {
      const i = state.pending.findIndex((a) => a.id === action.payload.id);
      if (i >= 0) state.pending[i] = action.payload;
      else state.pending.unshift(action.payload);
      if (!state.focusId) state.focusId = action.payload.id;
    },
  },
  extraReducers: (b) => {
    b.addCase(hydrateFromCache.fulfilled, (s, a) => {
      s.pending = a.payload;
      if (a.payload.length > 0 && !s.focusId) s.focusId = a.payload[0].id;
    });

    b.addCase(refreshPending.pending, (s) => {
      s.loading = true;
      s.error = null;
    });
    b.addCase(refreshPending.fulfilled, (s, a) => {
      s.loading = false;
      s.pending = a.payload;
      if (a.payload.length > 0 && !s.focusId) s.focusId = a.payload[0].id;
      if (a.payload.length === 0) s.focusId = null;
    });
    b.addCase(refreshPending.rejected, (s, a) => {
      s.loading = false;
      s.error = a.error.message ?? 'Failed to load approvals';
    });

    b.addCase(fetchOne.fulfilled, (s, a) => {
      const i = s.pending.findIndex((x) => x.id === a.payload.id);
      if (i >= 0) s.pending[i] = a.payload;
      else s.pending.unshift(a.payload);
    });

    b.addCase(approve.pending, (s, a) => {
      s.decisionInFlight[a.meta.arg] = 'approve';
    });
    b.addCase(approve.fulfilled, (s, a) => {
      delete s.decisionInFlight[a.payload.id];
      s.pending = s.pending.filter((x) => x.id !== a.payload.id);
      if (s.focusId === a.payload.id) s.focusId = s.pending[0]?.id ?? null;
    });
    b.addCase(approve.rejected, (s, a) => {
      delete s.decisionInFlight[a.meta.arg];
      s.error = a.error.message ?? 'Approve failed';
    });

    b.addCase(deny.pending, (s, a) => {
      s.decisionInFlight[a.meta.arg.id] = 'deny';
    });
    b.addCase(deny.fulfilled, (s, a) => {
      delete s.decisionInFlight[a.payload.id];
      s.pending = s.pending.filter((x) => x.id !== a.payload.id);
      if (s.focusId === a.payload.id) s.focusId = s.pending[0]?.id ?? null;
    });
    b.addCase(deny.rejected, (s, a) => {
      delete s.decisionInFlight[a.meta.arg.id];
      s.error = a.error.message ?? 'Deny failed';
    });
  },
});

export const { setFocus, markExpired, upsert } = slice.actions;
export default slice.reducer;
```

- [ ] **Step 10.2: Wire into root store**

Modify `apps/mobile/src/store/index.ts` — add the reducer to the store config alongside `auth` and `alerts`. Match the existing pattern. Example pattern (adapt to actual file shape):

```ts
import approvalsReducer from './approvalsSlice';
// ...
const store = configureStore({
  reducer: {
    auth: authReducer,
    alerts: alertsReducer,
    approvals: approvalsReducer,
  },
});
```

- [ ] **Step 10.3: Verify typecheck**

```bash
cd apps/mobile && pnpm typecheck
```
Expected: PASS.

- [ ] **Step 10.4: Commit**

```bash
git add apps/mobile/src/store/approvalsSlice.ts apps/mobile/src/store/index.ts
git commit -m "$(cat <<'EOF'
feat(mobile): add approvals slice with cache hydration + decision thunks

Async thunks (hydrate, refresh, approve, deny) with cache write-through
and removal on success. Tracks decisionInFlight per id so the UI can
disable buttons and show progress without flicker. Slice keeps focusId in
sync as approvals enter/leave the queue.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Mobile — CountdownRing component

**Files:**
- Modify: `apps/mobile/package.json` (add `react-native-svg`)
- Create: `apps/mobile/src/screens/approvals/components/CountdownRing.tsx`

- [ ] **Step 11.1: Add `react-native-svg`**

```bash
cd apps/mobile && pnpm add react-native-svg
```

- [ ] **Step 11.2: Create the component**

```tsx
import { useEffect } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { useApprovalTheme } from '../../../theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface Props {
  expiresAt: string;
  size?: number;
  stroke?: number;
  onExpire?: () => void;
}

export function CountdownRing({ expiresAt, size = 56, stroke = 3, onExpire }: Props) {
  const theme = useApprovalTheme('dark');
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  const totalMs = Math.max(1, new Date(expiresAt).getTime() - Date.now());
  const progress = useSharedValue(1);

  useEffect(() => {
    const remaining = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    progress.value = remaining / totalMs;
    progress.value = withTiming(
      0,
      { duration: remaining, easing: Easing.linear },
      (finished) => {
        if (finished && onExpire) {
          // dispatch on JS thread
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          onExpire();
        }
      }
    );
    return () => cancelAnimation(progress);
  }, [expiresAt]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
  }));

  return (
    <View>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={theme.bg3}
          strokeWidth={stroke}
          fill="none"
        />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={theme.brand}
          strokeWidth={stroke}
          strokeDasharray={`${circumference} ${circumference}`}
          animatedProps={animatedProps}
          fill="none"
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
    </View>
  );
}
```

- [ ] **Step 11.3: Verify typecheck**

```bash
cd apps/mobile && pnpm typecheck
```
Expected: PASS.

- [ ] **Step 11.4: Commit**

```bash
git add apps/mobile/package.json apps/mobile/pnpm-lock.yaml apps/mobile/src/screens/approvals/components/CountdownRing.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): add CountdownRing approval timer (SVG + Reanimated)

Linear stroke-dashoffset animation tied to expiresAt; fires onExpire on
the JS thread when reaching zero. Cancels its animation on unmount.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Mobile — RequesterRow, ActionHeadline, RiskBand, DetailsCollapse

These four are pure-presentation components. Build them in one task with one commit since they're tightly coupled and small.

**Files:**
- Create: `apps/mobile/src/screens/approvals/components/RequesterRow.tsx`
- Create: `apps/mobile/src/screens/approvals/components/ActionHeadline.tsx`
- Create: `apps/mobile/src/screens/approvals/components/RiskBand.tsx`
- Create: `apps/mobile/src/screens/approvals/components/DetailsCollapse.tsx`

- [ ] **Step 12.1: RequesterRow.tsx**

```tsx
import { Text, View } from 'react-native';
import { useApprovalTheme, type, spacing } from '../../../theme';

interface Props {
  clientLabel: string;
  machineLabel: string | null;
  createdAt: string;
}

export function RequesterRow({ clientLabel, machineLabel, createdAt }: Props) {
  const theme = useApprovalTheme('dark');
  const time = new Date(createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[4] }}>
      <Text style={[type.metaCaps, { color: theme.textLo, marginBottom: spacing[2] }]}>
        REQUESTING
      </Text>
      <Text style={[type.bodyMd, { color: theme.textHi }]}>{clientLabel}</Text>
      {machineLabel ? (
        <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
          {machineLabel} · {time}
        </Text>
      ) : (
        <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>{time}</Text>
      )}
    </View>
  );
}
```

- [ ] **Step 12.2: ActionHeadline.tsx**

```tsx
import { Text, View } from 'react-native';
import { useApprovalTheme, type, spacing } from '../../../theme';

interface Props {
  action: string;
}

export function ActionHeadline({ action }: Props) {
  const theme = useApprovalTheme('dark');
  return (
    <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[8] }}>
      <Text style={[type.display, { color: theme.textHi }]}>{action}</Text>
    </View>
  );
}
```

- [ ] **Step 12.3: RiskBand.tsx**

```tsx
import { Text, View } from 'react-native';
import { riskTier, type RiskTier, useApprovalTheme, type, spacing, radii } from '../../../theme';

interface Props {
  tier: RiskTier;
  summary: string;
}

const TIER_COPY: Record<RiskTier, string> = {
  low: 'Low impact',
  medium: 'Medium impact',
  high: 'High impact',
  critical: 'Critical',
};

export function RiskBand({ tier, summary }: Props) {
  const theme = useApprovalTheme('dark');
  const colors = riskTier[tier];
  return (
    <View
      style={{
        marginHorizontal: spacing[6],
        marginTop: spacing[6],
        padding: spacing[4],
        borderRadius: radii.md,
        backgroundColor: colors.band,
      }}
    >
      <Text style={[type.metaCaps, { color: colors.text }]}>{TIER_COPY[tier]}</Text>
      <Text style={[type.body, { color: colors.text, marginTop: spacing[1] }]}>{summary}</Text>
    </View>
  );
}
```

- [ ] **Step 12.4: DetailsCollapse.tsx**

```tsx
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';

interface Props {
  toolName: string;
  args: Record<string, unknown>;
}

function prettyArgs(args: Record<string, unknown>): string {
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

export function DetailsCollapse({ toolName, args }: Props) {
  const theme = useApprovalTheme('dark');
  const [open, setOpen] = useState(false);

  return (
    <View
      style={{
        marginHorizontal: spacing[6],
        marginTop: spacing[5],
        borderRadius: radii.md,
        backgroundColor: theme.bg2,
        borderColor: theme.border,
        borderWidth: 1,
      }}
    >
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={{ padding: spacing[4], flexDirection: 'row', justifyContent: 'space-between' }}
      >
        <View style={{ flex: 1, marginRight: spacing[3] }}>
          <Text style={[type.metaCaps, { color: theme.textLo }]}>TOOL</Text>
          <Text style={[type.monoMd, { color: theme.textHi, marginTop: spacing[1] }]}>{toolName}</Text>
        </View>
        <Text style={[type.meta, { color: theme.textMd }]}>{open ? 'Hide' : 'Show'} details</Text>
      </Pressable>
      {open ? (
        <View
          style={{
            paddingHorizontal: spacing[4],
            paddingBottom: spacing[4],
            borderTopColor: theme.border,
            borderTopWidth: 1,
          }}
        >
          <Text
            style={[type.mono, { color: theme.textHi, marginTop: spacing[3] }]}
            selectable
          >
            {prettyArgs(args)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
```

- [ ] **Step 12.5: Verify typecheck**

```bash
cd apps/mobile && pnpm typecheck
```
Expected: PASS.

- [ ] **Step 12.6: Commit**

```bash
git add apps/mobile/src/screens/approvals/components/{RequesterRow,ActionHeadline,RiskBand,DetailsCollapse}.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): add approval-mode presentation components

RequesterRow: who's asking + timestamp.
ActionHeadline: display-size action in plain English.
RiskBand: tier-colored summary band.
DetailsCollapse: tool name (mono) + JSON args, default-collapsed; the mono
type IS the trust signal.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Mobile — ApprovalButtons (Deny + Approve with biometric + recursive hold)

**Files:**
- Create: `apps/mobile/src/screens/approvals/components/HoldToConfirm.tsx`
- Create: `apps/mobile/src/screens/approvals/components/DenyReasonSheet.tsx`
- Create: `apps/mobile/src/screens/approvals/components/ApprovalButtons.tsx`

- [ ] **Step 13.1: HoldToConfirm.tsx (5s recursive)**

```tsx
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  cancelAnimation,
  runOnJS,
} from 'react-native-reanimated';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';
import { ease, duration, haptic } from '../../../lib/motion';

interface Props {
  label: string;
  onComplete: () => void;
  durationMs?: number;
}

export function HoldToConfirm({ label, onComplete, durationMs = 5000 }: Props) {
  const theme = useApprovalTheme('dark');
  const progress = useSharedValue(0);

  useEffect(() => () => cancelAnimation(progress), []);

  const onPressIn = () => {
    haptic.tap();
    progress.value = withTiming(1, { duration: durationMs }, (finished) => {
      if (finished) {
        runOnJS(haptic.hold)();
        runOnJS(onComplete)();
      }
    });
  };
  const onPressOut = () => {
    progress.value = withTiming(0, { duration: duration.fast, easing: ease });
  };

  const fillStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  return (
    <Pressable onPressIn={onPressIn} onPressOut={onPressOut}>
      <View
        style={{
          height: 56,
          borderRadius: radii.lg,
          backgroundColor: theme.bg2,
          overflow: 'hidden',
          justifyContent: 'center',
          alignItems: 'center',
          borderColor: theme.brand,
          borderWidth: 1,
        }}
      >
        <Animated.View
          style={[
            { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: theme.brand, opacity: 0.35 },
            fillStyle,
          ]}
        />
        <Text style={[type.bodyMd, { color: theme.textHi }]}>{label}</Text>
      </View>
    </Pressable>
  );
}
```

- [ ] **Step 13.2: DenyReasonSheet.tsx**

```tsx
import { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';

interface Props {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (reason: string | undefined) => void;
}

export function DenyReasonSheet({ visible, onCancel, onSubmit }: Props) {
  const theme = useApprovalTheme('dark');
  const [reason, setReason] = useState('');

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
        onPress={onCancel}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: theme.bg1,
            borderTopLeftRadius: radii.xl,
            borderTopRightRadius: radii.xl,
            padding: spacing[6],
            paddingBottom: spacing[10],
          }}
        >
          <Text style={[type.title, { color: theme.textHi }]}>Why deny?</Text>
          <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
            Optional. Helps the requesting session understand.
          </Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Reason"
            placeholderTextColor={theme.textLo}
            multiline
            style={[
              type.body,
              {
                color: theme.textHi,
                backgroundColor: theme.bg2,
                borderRadius: radii.md,
                padding: spacing[4],
                marginTop: spacing[4],
                minHeight: 88,
                textAlignVertical: 'top',
              },
            ]}
          />
          <View style={{ flexDirection: 'row', marginTop: spacing[5], gap: spacing[3] }}>
            <Pressable
              onPress={onCancel}
              style={{ flex: 1, paddingVertical: spacing[4], alignItems: 'center', borderRadius: radii.md, backgroundColor: theme.bg2 }}
            >
              <Text style={[type.bodyMd, { color: theme.textHi }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => onSubmit(reason.trim() || undefined)}
              style={{ flex: 1, paddingVertical: spacing[4], alignItems: 'center', borderRadius: radii.md, backgroundColor: theme.deny }}
            >
              <Text style={[type.bodyMd, { color: '#fff5f3' }]}>Deny</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

- [ ] **Step 13.3: ApprovalButtons.tsx**

```tsx
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { HoldToConfirm } from './HoldToConfirm';
import { DenyReasonSheet } from './DenyReasonSheet';

interface Props {
  isRecursive: boolean;
  inFlight: 'approve' | 'deny' | null;
  onApprove: () => void;
  onDeny: (reason?: string) => void;
}

export function ApprovalButtons({ isRecursive, inFlight, onApprove, onDeny }: Props) {
  const theme = useApprovalTheme('dark');
  const [denyOpen, setDenyOpen] = useState(false);
  const [biometricFailed, setBiometricFailed] = useState(false);

  async function handleApprovePress() {
    haptic.tap();
    setBiometricFailed(false);
    const hasHw = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();

    if (!hasHw || !enrolled) {
      // No biometric available — fall back to passcode prompt.
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Confirm to approve',
        disableDeviceFallback: false,
      });
      if (!r.success) { setBiometricFailed(true); return; }
      onApprove();
      return;
    }

    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Approve this request',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    if (!r.success) { setBiometricFailed(true); return; }
    onApprove();
  }

  return (
    <View>
      {biometricFailed ? (
        <Text style={[type.meta, { color: theme.deny, paddingHorizontal: spacing[6], marginBottom: spacing[2] }]}>
          Biometric failed. Try again.
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', paddingHorizontal: spacing[6], gap: spacing[3] }}>
        <Pressable
          onPress={() => { haptic.tap(); setDenyOpen(true); }}
          disabled={inFlight !== null}
          style={({ pressed }) => ({
            flex: 1,
            paddingVertical: spacing[5],
            borderRadius: radii.lg,
            backgroundColor: pressed ? theme.bg3 : theme.bg2,
            alignItems: 'center',
            opacity: inFlight === 'deny' ? 0.6 : 1,
          })}
        >
          <Text style={[type.bodyMd, { color: theme.textHi }]}>Deny</Text>
        </Pressable>

        {isRecursive ? (
          <View style={{ flex: 1.4 }}>
            <HoldToConfirm label="Hold to approve" onComplete={handleApprovePress} />
          </View>
        ) : (
          <Pressable
            onPress={handleApprovePress}
            disabled={inFlight !== null}
            style={({ pressed }) => ({
              flex: 1.4,
              paddingVertical: spacing[5],
              borderRadius: radii.lg,
              backgroundColor: pressed ? '#208c50' : theme.approve,
              alignItems: 'center',
              opacity: inFlight === 'approve' ? 0.6 : 1,
            })}
          >
            <Text style={[type.bodyMd, { color: '#04230f' }]}>Approve</Text>
          </Pressable>
        )}
      </View>

      <DenyReasonSheet
        visible={denyOpen}
        onCancel={() => setDenyOpen(false)}
        onSubmit={(reason) => { setDenyOpen(false); onDeny(reason); }}
      />
    </View>
  );
}
```

- [ ] **Step 13.4: Verify typecheck**

```bash
cd apps/mobile && pnpm typecheck
```
Expected: PASS.

- [ ] **Step 13.5: Commit**

```bash
git add apps/mobile/src/screens/approvals/components/{ApprovalButtons,HoldToConfirm,DenyReasonSheet}.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): add approval action surface (biometric + recursive hold)

Approve gates on expo-local-authentication every time, with a passcode
fallback path when hardware/enrollment isn't available. Recursive case
swaps the Approve tap for a 5s HoldToConfirm with a brand-tinted progress
fill. Deny opens a slide-up sheet with optional reason, never a hard
modal that blocks the screen.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Mobile — ApprovalScreen assembly + animations

**Files:**
- Create: `apps/mobile/src/screens/approvals/components/ApprovalToast.tsx`
- Create: `apps/mobile/src/screens/approvals/ApprovalScreen.tsx`

- [ ] **Step 14.1: ApprovalToast.tsx**

```tsx
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, runOnJS } from 'react-native-reanimated';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';
import { duration, ease } from '../../../lib/motion';

interface Props {
  visible: boolean;
  text: string;
  kind: 'approve' | 'deny';
  onHidden: () => void;
}

export function ApprovalToast({ visible, text, kind, onHidden }: Props) {
  const theme = useApprovalTheme('dark');
  const opacity = useSharedValue(0);
  const ty = useSharedValue(20);

  useEffect(() => {
    if (visible) {
      opacity.value = withTiming(1, { duration: duration.base, easing: ease });
      ty.value = withTiming(0, { duration: duration.base, easing: ease });
      const t = setTimeout(() => {
        opacity.value = withTiming(0, { duration: duration.fast, easing: ease });
        ty.value = withTiming(10, { duration: duration.fast, easing: ease }, (finished) => {
          if (finished) runOnJS(onHidden)();
        });
      }, 1800);
      return () => clearTimeout(t);
    }
  }, [visible]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: ty.value }],
  }));

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: spacing[6],
          right: spacing[6],
          bottom: spacing[20],
          padding: spacing[4],
          borderRadius: radii.md,
          backgroundColor: kind === 'approve' ? theme.approve : theme.deny,
        },
        style,
      ]}
    >
      <Text style={[type.bodyMd, { color: kind === 'approve' ? '#04230f' : '#fff5f3' }]}>{text}</Text>
    </Animated.View>
  );
}
```

- [ ] **Step 14.2: ApprovalScreen.tsx (the host)**

```tsx
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSequence,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView } from 'react-native-gesture-handler';

import { useAppDispatch, useAppSelector } from '../../store';
import { approve, deny, hydrateFromCache, markExpired, refreshPending } from '../../store/approvalsSlice';
import { useApprovalTheme, type, spacing, palette } from '../../theme';
import { duration, ease, haptic } from '../../lib/motion';

import { CountdownRing } from './components/CountdownRing';
import { RequesterRow } from './components/RequesterRow';
import { ActionHeadline } from './components/ActionHeadline';
import { DetailsCollapse } from './components/DetailsCollapse';
import { RiskBand } from './components/RiskBand';
import { ApprovalButtons } from './components/ApprovalButtons';
import { ApprovalToast } from './components/ApprovalToast';

export function ApprovalScreen() {
  const insets = useSafeAreaInsets();
  const theme = useApprovalTheme('dark');
  const dispatch = useAppDispatch();

  const focused = useAppSelector((s) => s.approvals.pending.find((a) => a.id === s.approvals.focusId));
  const inFlight = useAppSelector((s) =>
    focused ? (s.approvals.decisionInFlight[focused.id] ?? null) : null
  );

  const enter = useSharedValue(0);
  const successWash = useSharedValue(0);
  const denyShake = useSharedValue(0);

  const [toast, setToast] = useState<{ kind: 'approve' | 'deny'; text: string } | null>(null);

  // Mount: hydrate cache, then refresh from server, then play entrance.
  useEffect(() => {
    dispatch(hydrateFromCache());
    dispatch(refreshPending());
    enter.value = withTiming(1, { duration: duration.enter, easing: ease });
    haptic.arrive();
  }, []);

  const enterStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 24 }],
  }));

  const washStyle = useAnimatedStyle(() => ({
    opacity: successWash.value,
    transform: [{ translateY: (1 - successWash.value) * 200 }],
  }));

  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: denyShake.value }],
  }));

  function handleApprove() {
    if (!focused) return;
    successWash.value = withSequence(
      withTiming(1, { duration: 200, easing: ease }),
      withTiming(0, { duration: 600, easing: ease })
    );
    haptic.approve();
    dispatch(approve(focused.id))
      .unwrap()
      .then(() => {
        runOnJS(setToast)({ kind: 'approve', text: `Approved · ${focused.actionLabel}` });
      })
      .catch(() => {
        runOnJS(setToast)({ kind: 'deny', text: 'Approve failed. Try again.' });
      });
  }

  function handleDeny(reason?: string) {
    if (!focused) return;
    denyShake.value = withSequence(
      withTiming(-4, { duration: 40 }),
      withTiming(4, { duration: 40 }),
      withTiming(0, { duration: 40 })
    );
    haptic.deny();
    dispatch(deny({ id: focused.id, reason }))
      .unwrap()
      .then(() => {
        runOnJS(setToast)({ kind: 'deny', text: 'Denied · logged' });
      })
      .catch(() => {
        runOnJS(setToast)({ kind: 'deny', text: 'Deny failed. Try again.' });
      });
  }

  function handleExpire() {
    if (!focused) return;
    dispatch(markExpired(focused.id));
  }

  // Empty state: rare in this surface — only shown if user opened the app
  // expecting a pending approval and there isn't one (race with expiry, or
  // approval already actioned elsewhere).
  if (!focused) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg0, paddingTop: insets.top + spacing[10], paddingHorizontal: spacing[6] }}>
        <Text style={[type.title, { color: theme.textHi }]}>No pending approvals</Text>
        <Text style={[type.body, { color: theme.textMd, marginTop: spacing[2] }]}>
          You're all caught up.
        </Text>
      </View>
    );
  }

  // Recursive case: requesting client is THIS phone. v1 heuristic — match on
  // a known label prefix. Replace with a server-issued `isRecursive` flag in
  // a follow-up.
  const isRecursive = focused.requestingClientLabel.startsWith('Breeze Mobile');

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg0 }}>
      <Animated.View style={[{ flex: 1 }, enterStyle, shakeStyle]}>
        <View
          style={{
            paddingTop: insets.top + spacing[3],
            paddingHorizontal: spacing[6],
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <CountdownRing
            expiresAt={focused.expiresAt}
            onExpire={handleExpire}
          />
          <Pressable
            onPress={() => { /* report-as-suspicious sheet stub for v1 */ }}
            hitSlop={12}
          >
            <Text style={[type.meta, { color: theme.textMd }]}>Report</Text>
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: spacing[16] }}>
          <RequesterRow
            clientLabel={focused.requestingClientLabel}
            machineLabel={focused.requestingMachineLabel}
            createdAt={focused.createdAt}
          />
          <ActionHeadline action={focused.actionLabel} />
          <RiskBand tier={focused.riskTier} summary={focused.riskSummary} />
          <DetailsCollapse toolName={focused.actionToolName} args={focused.actionArguments} />
        </ScrollView>

        <View style={{ paddingBottom: insets.bottom + spacing[5] }}>
          <ApprovalButtons
            isRecursive={isRecursive}
            inFlight={inFlight}
            onApprove={handleApprove}
            onDeny={handleDeny}
          />
        </View>
      </Animated.View>

      {/* Success wash — sweeps up from the bottom on approve */}
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            top: 0,
            backgroundColor: palette.approve.wash,
          },
          washStyle,
        ]}
      />

      <ApprovalToast
        visible={!!toast}
        text={toast?.text ?? ''}
        kind={toast?.kind ?? 'approve'}
        onHidden={() => setToast(null)}
      />
    </View>
  );
}
```

- [ ] **Step 14.3: Verify typecheck**

```bash
cd apps/mobile && pnpm typecheck
```
Expected: PASS.

- [ ] **Step 14.4: Commit**

```bash
git add apps/mobile/src/screens/approvals/components/ApprovalToast.tsx apps/mobile/src/screens/approvals/ApprovalScreen.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): assemble ApprovalScreen with entrance + decision animations

400ms slide-up entrance + soft haptic on mount, success wash sweeping up
from the bottom on approve, 4px shake on deny, silent dimming on expiry.
Recursive heuristic (client label starts with "Breeze Mobile") swaps in
HoldToConfirm; replace with a server-issued flag in a follow-up.
"Report" link is a stub — sheet content lands in phase 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Mobile — Navigation interception (push → approval, foreground → approval)

**Files:**
- Modify: `apps/mobile/src/services/notifications.ts` (project ID + parser)
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx` (mount approval route)
- Create: `apps/mobile/src/navigation/ApprovalGate.tsx` (decides when to show approval mode)
- Modify: `apps/mobile/app.json` (Expo project ID, notification channel)

- [ ] **Step 15.1: Set the Expo project ID**

The current code has `'your-project-id'` placeholder. Replace with the real one. In `apps/mobile/app.json`, ensure:

```json
{
  "expo": {
    "extra": {
      "eas": { "projectId": "<actual-expo-project-id>" }
    }
  }
}
```

If the project hasn't been created in EAS yet, create it (`npx eas init` from `apps/mobile/`) and capture the ID.

In `apps/mobile/src/services/notifications.ts`, change:
```ts
const tokenData = await Notifications.getExpoPushTokenAsync({
  projectId: 'your-project-id',
});
```
to:
```ts
import Constants from 'expo-constants';
// ...
const projectId = Constants.expoConfig?.extra?.eas?.projectId;
if (!projectId) throw new Error('EAS projectId missing — run `eas init`');
const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
```

Also add an "approvals" channel for Android in the same file (next to "alerts"):
```ts
await Notifications.setNotificationChannelAsync('approvals', {
  name: 'Approvals',
  importance: Notifications.AndroidImportance.MAX,
  vibrationPattern: [0, 200, 100, 200],
  lightColor: '#1c8a9e',
  sound: 'default',
});
```

And a parser:
```ts
export function parseApprovalNotification(
  notification: Notifications.Notification | Notifications.NotificationResponse['notification']
): { approvalId: string } | null {
  const data = notification.request.content.data;
  if (data && data.type === 'approval' && typeof data.approvalId === 'string') {
    return { approvalId: data.approvalId };
  }
  return null;
}
```

- [ ] **Step 15.2: Create `apps/mobile/src/navigation/ApprovalGate.tsx`**

```tsx
import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { fetchOne, refreshPending, setFocus, hydrateFromCache } from '../store/approvalsSlice';
import {
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  parseApprovalNotification,
  removeNotificationSubscription,
} from '../services/notifications';
import { ApprovalScreen } from '../screens/approvals/ApprovalScreen';

interface Props {
  children: React.ReactNode;
}

// Renders ApprovalScreen as a global takeover whenever there is a focused
// pending approval. Otherwise renders the regular nav tree.
export function ApprovalGate({ children }: Props) {
  const dispatch = useAppDispatch();
  const focused = useAppSelector((s) =>
    s.approvals.pending.find((a) => a.id === s.approvals.focusId && a.status === 'pending')
  );

  useEffect(() => {
    dispatch(hydrateFromCache());
    dispatch(refreshPending());

    const recv = addNotificationReceivedListener((n) => {
      const parsed = parseApprovalNotification(n);
      if (parsed) {
        dispatch(fetchOne(parsed.approvalId));
        dispatch(setFocus(parsed.approvalId));
      }
    });
    const tap = addNotificationResponseReceivedListener((r) => {
      const parsed = parseApprovalNotification(r.notification);
      if (parsed) {
        dispatch(fetchOne(parsed.approvalId));
        dispatch(setFocus(parsed.approvalId));
      }
    });

    return () => {
      removeNotificationSubscription(recv);
      removeNotificationSubscription(tap);
    };
  }, []);

  if (focused) {
    return <ApprovalScreen />;
  }
  return <>{children}</>;
}
```

- [ ] **Step 15.3: Mount in `apps/mobile/src/navigation/RootNavigator.tsx`**

Wrap the existing token-gated `MainNavigator` with `ApprovalGate`:

```tsx
import { ApprovalGate } from './ApprovalGate';
// ...
return (
  <NavigationContainer theme={navigationTheme}>
    {token ? (
      <ApprovalGate>
        <MainNavigator />
      </ApprovalGate>
    ) : (
      <AuthNavigator />
    )}
  </NavigationContainer>
);
```

- [ ] **Step 15.4: Verify typecheck**

```bash
cd apps/mobile && pnpm typecheck
```
Expected: PASS.

- [ ] **Step 15.5: Commit**

```bash
git add apps/mobile/app.json apps/mobile/src/services/notifications.ts apps/mobile/src/navigation/ApprovalGate.tsx apps/mobile/src/navigation/RootNavigator.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): wire approval-mode takeover via push + foreground gate

ApprovalGate hydrates the cache, refreshes from server, and listens for
incoming push or notification taps to set focus and render
ApprovalScreen on top of the regular nav tree. Replaces the broken
'your-project-id' placeholder with a Constants-driven EAS project ID and
adds an Android 'approvals' channel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: End-to-end manual verification

This task ships nothing new but locks the phase 1 deliverable.

- [ ] **Step 16.1: Bring everything up**

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up -d
cd apps/api && pnpm dev &
cd apps/mobile && pnpm start
```

Open the mobile app on a physical device with a recent Expo Go build OR a custom dev client.

- [ ] **Step 16.2: Sign in, register push token**

After login, check the API logs for the `register-push-token` call. Verify a row exists:
```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "SELECT user_id, platform, fcm_token IS NOT NULL OR apns_token IS NOT NULL AS has_token FROM mobile_devices;"
```

- [ ] **Step 16.3: Seed an approval**

```bash
TOKEN="<the JWT for the same user>"
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
    "requestingMachineLabel": "Test Device",
    "expiresInSeconds": 60
  }'
```

Expected on the phone, in order:
1. Push notification arrives within ~5s. Lock screen shows: "Approval requested — Claude Desktop: Delete 4 devices in Acme Corp."
2. Tapping the notification opens the app directly into approval mode.
3. The countdown ring is visible and ticking.
4. Tapping Approve triggers biometric. On success, a green wash sweeps up, success haptic fires, and a toast reads "Approved · Delete 4 devices in Acme Corp."
5. The approval row in the DB shows `status='approved'` and `decided_at` populated.

- [ ] **Step 16.4: Repeat for deny**

Seed a second approval. Tap Deny → reason sheet → submit empty (no reason). Toast reads "Denied · logged." DB row shows `status='denied'`.

- [ ] **Step 16.5: Repeat for expiry**

Seed a third with `"expiresInSeconds": 15`. Open the app, watch the ring complete. The screen dims silently (no haptic). DB row eventually shows `status='expired'` after a follow-up `markExpired` reducer (status updates locally only — server expiry is implicit via `expires_at` checks). Acceptable for v1.

- [ ] **Step 16.6: Recursive case (manual)**

Seed an approval with `"requestingClientLabel": "Breeze Mobile"`. Verify Approve becomes a Hold-to-confirm bar that requires the full 5s.

- [ ] **Step 16.7: Offline cold open**

Approve a fresh seed but turn airplane mode ON before tapping. Force-quit the app. Reopen with airplane mode still on. The approval should render from cache. (Approve will fail at network — expected for v1; that's acceptable since the brief promised offline *render*, not offline approval.)

- [ ] **Step 16.8: Tear down test approvals**

```bash
docker exec -it breeze-postgres psql -U breeze -d breeze \
  -c "DELETE FROM approval_requests WHERE requesting_client_label IN ('Dev Seed','Claude Desktop','Breeze Mobile');"
```

- [ ] **Step 16.9: Commit a verification note**

If anything in this run-through revealed a bug, fix it before committing this step. Otherwise, no code change here — just a note in the PR description summarizing the verification.

---

## Self-Review

Spec coverage:
- Approval mode UI with all listed states (default, reading, approving, denying, expired, recursive) → Tasks 11-14, verified in 16.
- Push delivery with payload limited to action verb + client label → Task 7 (`buildApprovalPush`), Task 15 (channel).
- Biometric on every approve, recursive 5s hold → Task 13.
- Offline cache → Tasks 9-10, verified in 16.7.
- Theme tokens (oklch teal, status roles, tinted neutrals) + Geist → Tasks 1-3.
- Backend schema, RLS, routes, tests, dev seed → Tasks 5-8.
- Brief decisions locked: payload only action+client (Task 7), 5s recursive hold (Task 13), text-only AI deferred to phase 2 (out of scope), live signal limited to client/machine label (Task 5/8 schema).

Deferred and explicitly noted out-of-scope: report-as-suspicious sheet (link is a stub in Task 14), multi-pending swipe (focus is single-id v1), AI/Systems tabs, settings polish, light mode iteration, MCP enforcement integration.

Placeholder scan: every code step has full code. No "implement later" or "similar to Task N" hand-waves.

Type consistency: `RiskTier`, `ApprovalRequest`, and `ApprovalStatus` are defined in `services/approvals.ts` and imported uniformly. Theme tokens (`type`, `spacing`, `radii`, `palette`, `useApprovalTheme`, `riskTier`) all come from `theme/`. Reanimated, expo-haptics, expo-local-authentication imports stay consistent across files.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-06-mobile-approval-mode.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best when individual tasks are large enough that a clean context window helps (this plan: yes).

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Best when you want me holding more conversation context across tasks.

Which approach?
