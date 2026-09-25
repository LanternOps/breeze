import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { envStackPath } from './project';

/** Deterministic dev defaults — NOT secrets, local-only. Keeps a fresh worktree
 *  from booting with a partial env (the missing-.env.test → vacuous-RLS trap). */
const DEV_ENV: Record<string, string> = {
  POSTGRES_USER: 'breeze',
  POSTGRES_PASSWORD: 'breeze',
  POSTGRES_DB: 'breeze',
  ENROLLMENT_KEY_PEPPER: 'dev-enrollment-pepper-0000000000000000',
  MFA_RECOVERY_CODE_PEPPER: 'dev-mfa-pepper-00000000000000000000',
  TURN_SECRET: 'dev-turn-secret',
  IS_HOSTED: 'false',
  ENABLE_REGISTRATION: 'true',
  BINARY_SOURCE: 'github',
  CADDY_SITE_ADDRESS: ':80',
  BREEZE_PORTAL_IMAGE_REF: 'breeze-portal:dev',
  // The next four are required by `x-api-env` (docker-compose.yml) with no
  // default and postdate several developers' root .env — a stale .env leaves
  // a fresh worktree unable to boot at all. Values match .env.example's own
  // documented defaults.
  REMOTE_ACCESS_ADMISSION_MODE: 'open',
  EVENT_PERMISSION_EPOCH_MODE: 'compat',
  REMOTE_WS_AUTH_MODE: 'post_upgrade',
  REMOTE_WS_REDIS_TOPOLOGY: 'standalone-single-primary',
  // #5266 — the seeded system Partner Admin role stores `force_mfa = true`
  // (#4491), and this stack's only login is the bootstrap `admin@breeze.local`,
  // which holds that role. If enforcement is left to the API's shipping default
  // that admin is minted `mfa: false`, gets `428 mfa_enrollment_required` on its
  // first protected request, and Playwright's globalSetup lands on
  // /auth/mfa/setup instead of the dashboard — every spec then dies before it
  // runs. Pin the relief valve OFF here so the dev stack is deterministic
  // regardless of the shipping default (off this release, back ON once #5306's
  // grace-window feature lands) and regardless of what the developer's root
  // .env says — .env.stack is passed LAST, so it wins. This mirrors what the
  // portal-dev-e2e CI job already writes into its own .env. It suppresses only
  // the role-force component; settings-driven `security.requireMfa` still
  // applies, so MFA-policy specs are unaffected.
  MFA_FORCE_FOR_PARTNER_ADMIN: 'false',
  // Partner sending domains W05. `fake` is the deterministic adapter: it makes
  // no external calls itself, verifies `*.verify.test` on the first check, and
  // fails `*.fail.test`. A test send is suppressed unless the platform email
  // transport is SMTP (a local sink, e.g. Mailpit) — Resend/Mailgun, or no
  // email service configured at all, never see the fake domains this adapter
  // manages, since those domains were never registered with a real provider.
  // config/validate.ts refuses `fake` in production, and the settings tab is
  // hidden whenever this is unset — which is why the E2E spec needs it.
  // .env.stack is passed LAST to compose, so this wins over a stale root
  // .env, and docker-compose.yml's x-api-env anchor (added in W02) is what
  // carries it into the api and worker containers.
  EMAIL_DOMAINS_PROVIDER: 'fake',
  // #6447 — this stack exists to be driven by Playwright, and a Playwright run
  // is structurally indistinguishable from the runaway clients the API's rate
  // limiters exist to stop:
  //
  //  - `globalSetup` mints ONE storageState, so every context in the run —
  //    across all workers — replays the same refresh cookie and therefore
  //    shares a single refresh-token FAMILY. `POST /auth/refresh` is budgeted
  //    per family (60/60s, `getRefreshRateLimit()`), and `apps/web` is an Astro
  //    MPA that spends one refresh on EVERY full-page navigation. Four workers
  //    navigating concurrently blow 60 navigations a minute in seconds; the API
  //    429s, and the web app masks itself with "Too many requests —
  //    reconnecting. Retrying in 32s…" (AuthThrottledMask) or, once the access
  //    token is gone, bounces to "Your session expired". That is exactly how
  //    the portal-dev-e2e CI job went red on every PR the day a fourth,
  //    navigation-heavy spec joined its list.
  //  - Every request reaches the API through Caddy, so the global per-IP
  //    limiter (300/min, `middleware/globalRateLimit.ts`) sees the whole run as
  //    ONE client. Per-IP budgeting is meaningless on a single-tenant dev stack
  //    and only meters the suite against itself.
  //
  // `E2E_MODE` is the API's own switch for both. Its blast radius is WIDER than
  // those two limiters, and all of it is intended here — grep the flag before
  // assuming this list is complete:
  //
  //  - `middleware/globalRateLimit.ts` — global per-IP limiter off.
  //  - `routes/auth/login.ts` — BOTH the per-family refresh limiter and the
  //    per-IP/per-email login limiter off.
  //  - `services/jwt.ts` — access token 15m → 24h, refresh 7d → 30d, viewer
  //    2h → 24h. Welcome here: a longer access token is fewer refreshes, which
  //    is the pressure this whole block is about.
  //  - `routes/auth/helpers.ts` — the 350 ms auth-response timing floor off,
  //    so pre-auth endpoints answer at full speed.
  //
  // What it does NOT unlock here is the auth-transition test barrier
  // (`routes/auth/authTransitionTestBarrier.ts`): that additionally requires
  // NODE_ENV=test plus a 32-char secret, and this stack runs NODE_ENV
  // development (docker-compose.override.yml.dev / .worktree) with no such
  // secret. `config/validate.ts` refuses the flag outright under NODE_ENV
  // production, so a stack carrying it structurally cannot be a production one.
  //
  // The sibling auth-browser-transition CI job already sets it; pinning it in
  // the stack itself fixes local `wt-stack test` runs the same way.
  //
  // `e2e-tests/test-helpers.ts`'s `clearRefreshState` remains as a belt-and-
  // braces reset for a stack brought up without this, but it only fires between
  // tests and so cannot refill the budget inside one long-running test.
  E2E_MODE: 'true',
  // Caddy/postgres/redis images are digest-pinned in base compose; reuse the
  // values already present in the developer's root .env via compose interpolation.
};

/** Keys set after compose runs (see setStackEnvValues); a rewrite keeps them. */
const RUNTIME_KEYS = ['WEBAUTHN_ORIGIN', 'WEBAUTHN_RP_ID'] as const;

export function writeEnvStack(worktreePath: string): string {
  const p = envStackPath(worktreePath);
  // Carry runtime keys across a re-`up` so an unchanged stack is not recreated
  // twice (drop, then re-add); `up` still corrects a value that went stale.
  // Read .env.stack alone: a value in the root .env must not be copied here.
  const previous = existsSync(p) ? readFileSync(p, 'utf8').split('\n') : [];
  const kept = previous.filter((line) =>
    RUNTIME_KEYS.some((k) => new RegExp(`^\\s*${k}\\s*=`).test(line)));
  const body = [...Object.entries(DEV_ENV).map(([k, v]) => `${k}=${v}`), ...kept].join('\n') + '\n';
  writeFileSync(p, body, 'utf8');
  return p;
}

/**
 * #6443 — upsert keys into `.env.stack` once their values are known. The
 * WebAuthn origin is the caddy port compose publishes (`0:80`, random), which
 * exists only after `composeUp`, so it cannot live in DEV_ENV. Existing lines
 * for a key are replaced in place, never duplicated.
 */
export function setStackEnvValues(worktreePath: string, values: Record<string, string>): string {
  const p = envStackPath(worktreePath);
  const pending = new Map(Object.entries(values));
  const lines = existsSync(p) ? readFileSync(p, 'utf8').replace(/\n$/, '').split('\n') : [];
  const out: string[] = [];
  for (const line of lines) {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key !== undefined && values[key] !== undefined) {
      if (pending.has(key)) { out.push(`${key}=${values[key]}`); pending.delete(key); }
      continue;
    }
    out.push(line);
  }
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  writeFileSync(p, out.join('\n') + '\n', 'utf8');
  return p;
}

/**
 * #6443 — make passkeys work on this stack. The API verifies the browser origin
 * against WEBAUTHN_ORIGIN and the RP ID against WEBAUTHN_RP_ID, each falling
 * back to root-.env values that never describe a local stack on a random caddy
 * port. Pin both in `.env.stack` (which compose reads last, so it wins) and
 * recreate api when either differs from what compose would resolve. Returns
 * whether api was recreated.
 */
export function pinWebAuthnForStack(
  worktreePath: string,
  baseUrl: string,
  deps: { recreateApi: () => void; waitApiHealthy: () => void },
): boolean {
  const wanted = { WEBAUTHN_ORIGIN: baseUrl, WEBAUTHN_RP_ID: new URL(baseUrl).hostname };
  const stale = Object.entries(wanted).some(([k, v]) => readStackEnvValue(worktreePath, k) !== v);
  if (!stale) return false;
  setStackEnvValues(worktreePath, wanted);
  deps.recreateApi();
  deps.waitApiHealthy();
  return true;
}

/**
 * #5266 — read a value the way compose resolves it for this stack:
 * `--env-file .env --env-file .env.stack`, later file wins.
 *
 * Host-side tooling needs a few of these. `wt-stack test` has to hand
 * `REDIS_PASSWORD` to Playwright, because `e2e-tests/global-setup.ts` clears the
 * per-email login rate limiter with `redis-cli -a $REDIS_PASSWORD` and this
 * stack's redis requires auth — without it the DEL is rejected, a stale window
 * survives, and the one login globalSetup gets is answered `429 Too many login
 * attempts`, killing every spec exactly as the forced-MFA wall does.
 */
export function readStackEnvValue(worktreePath: string, key: string): string | undefined {
  let found: string | undefined;
  for (const file of ['.env', '.env.stack']) {
    const p = path.join(worktreePath, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m?.[1] !== key) continue;
      const raw = m[2];
      const quoted = /^(["'])(.*)\1$/.exec(raw);
      // A quoted value keeps everything inside the quotes; an unquoted one ends
      // at a whitespace-preceded `#`, the way compose's dotenv parser reads it.
      // `.env.example` puts trailing comments on values all over the place, so
      // not stripping them here would hand back e.g. `pw   # the redis password`.
      found = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trimEnd();
    }
  }
  return found;
}
