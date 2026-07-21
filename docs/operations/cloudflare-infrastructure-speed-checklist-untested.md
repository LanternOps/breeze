# Cloudflare Infrastructure and Speed Checklist (UNTESTED)

## Status

This document is a proposed infrastructure and performance checklist.  
It is **untested in production** and should be validated in staging/load tests first.

## Recommended Infrastructure Stack

Use this as the default reference architecture for speed and operational simplicity:

1. Cloudflare Edge:
- DNS
- CDN
- WAF + rate limiting
- TLS termination (HTTP/3 enabled)

2. Runtime:
- Cloudflare Workers for edge/server logic where possible
- Use Smart Placement for data-bound workloads

3. Primary Database:
- Managed Postgres (Neon / Supabase / RDS / equivalent)
- Connect via Cloudflare Hyperdrive for pooled/global DB access behavior

4. Blob/Object Storage:
- Cloudflare R2 for file assets, exports, uploads, and large blobs

5. Async Work:
- Cloudflare Queues for email/webhooks/background jobs with retries + DLQ

6. State/Coordination:
- KV for globally distributed read-heavy config
- Durable Objects only for strict consistency/realtime coordination

7. Observability:
- Cloudflare analytics/logging (plus existing app metrics and tracing stack)

## Speed Checklist (Outside Codebase)

### A) Cloudflare Edge Settings
- [ ] Proxy app/API hostnames through Cloudflare.
- [ ] Enable HTTP/3.
- [ ] Enable Brotli.
- [ ] Enable Tiered Cache.
- [ ] Enable Early Hints (if available on plan).

### B) Cache Rules
- [ ] Cache static assets (`/_astro/*`, fonts, images) with long TTL and immutable caching.
- [ ] Cache public portal branding endpoint at edge (`/api/v1/portal/branding*`).
- [ ] Keep authenticated API responses private unless using explicit user/org-safe cache keys.
- [ ] Verify cache key and bypass rules for auth headers/cookies.

### C) Transport and Origin
- [ ] Keep-alive between Cloudflare and origin enabled.
- [ ] TLS 1.3 enabled.
- [ ] Keep origin and database region close to primary user region.
- [ ] Ensure database pooling is active (Hyperdrive and/or PgBouncer pattern).

### D) Capacity and Reliability
- [ ] Autoscaling for API/runtime configured and tested.
- [ ] CPU/memory limits tuned to avoid throttling.
- [ ] DB indexes verified for high-frequency portal queries.
- [ ] Backpressure and queue retry policies tuned.

### E) Measurement and Guardrails
- [ ] Track p50/p95/p99 for API latency and TTFB.
- [ ] Track LCP/INP for portal pages.
- [ ] Track Cloudflare cache-hit ratio by route group.
- [ ] Add alerts for latency regressions and cache-hit drops.
- [ ] Add CI budgets for bundle size and API latency regressions.

## Rollout Plan (Recommended)

1. Enable edge/protocol settings (low risk).
2. Roll out cache rules for static + public endpoints.
3. Validate auth/private route behavior and cache safety.
4. Run load + synthetic tests from multiple regions.
5. Tighten budgets and alert thresholds after first stable week.

## Validation Notes

Before production rollout:

- Test with real auth flows (login/logout/session expiry).
- Confirm no private data is edge cached.
- Confirm cache invalidation behavior for branding/assets updates.
- Verify p95 latency and Web Vitals improvements against baseline.

---

If this checklist is adopted, update this document with measured before/after metrics and mark tested items explicitly.
