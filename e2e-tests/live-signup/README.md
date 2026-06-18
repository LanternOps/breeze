# Live Sign-up Monitor

On-demand synthetic monitor for the hosted partner sign-up flow. Per region it:
preflight → API register → UI register (Playwright) → email verify (via Resend) →
simulate payment → assert pending→active → purge every account it created.

## Setup
```bash
cp live-signup/.env.example live-signup/.env   # fill RESEND_API_KEY + SYNTHETIC_TEST_TOKEN
cd e2e-tests && pnpm install --ignore-workspace && npx playwright install chromium
```
`SYNTHETIC_TEST_TOKEN` must match the `SYNTHETIC_TEST_TOKEN` set on each region's API.

## Run
```bash
cd e2e-tests
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm monitor                 # both regions
pnpm monitor -- --region us                # one region
pnpm monitor -- --skip-ui --skip-verify    # fast preflight+API+cleanup
pnpm monitor -- --json                     # machine-readable
```
Exit `0` = all phases passed for all regions; `1` = a failure (the integration seam for future cron/Slack). Exit `2` = required env vars missing.

## How it works
- Canary accounts are `signup-canary+<runId>-<layer>@2breeze.app`. The API purge/payment
  endpoints (`/api/v1/internal/synthetic/*`) refuse (422) anything that doesn't match that
  pattern — even with the secret, only canaries can ever be touched.
- `simulate-payment` writes `payment_method_attached_at`; the real `partnerGuard` reconciliation
  then flips the partner pending→active on the next authenticated request. Stripe itself is NOT
  exercised (it lives in the separate breeze-billing service). See the design spec for the
  coverage tradeoff.
- Cleanup runs for every partner the run created, even if an earlier phase failed. After the
  per-run cleanup, a `purge-stale-canaries` sweep purges any canary partner older than 120 min —
  this catches orphans whose register response was lost (so their id was never captured). Every
  candidate is re-validated through the same canary latch before deletion.

## Notes
- Register rate limit is 3/hour/IP; two signups per region per run. Back-to-back runs from one IP
  within an hour can trip it.
- Requires `SYNTHETIC_TEST_TOKEN` to be set on the target region's API (off by default → endpoints
  return 503). See deploy wiring below.

## Deploy wiring (per region, when enabling the monitor)
On each droplet, the API enables these endpoints only when `SYNTHETIC_TEST_TOKEN` is set. Add it to
`/opt/breeze/.env` AND map it explicitly in the `api` service `environment:` block of
`/opt/breeze/docker-compose.yml` (compose only interpolates vars listed there). Optional:
`SYNTHETIC_TEST_IP_ALLOWLIST` (comma-separated) to restrict caller IPs. This is a manual prod step,
performed when turning the feature on — it is intentionally off by default.
