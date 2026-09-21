# Microsoft 365 tenant sync

## Action required for self-hosters

This release adds a scheduled snapshot of each connected Microsoft 365 tenant
(users, sign-in activity, Intune devices, Conditional Access policies, license
SKUs, Secure Score) with a daily posture rollup. **It ships switched off.**

### 1. Read the manifest v3 note first

The `customer-graph-read` permission manifest moves from version 2 to
version 3 in this same release. Everything you must do about that — the four
Microsoft Graph application permissions to add to your own app registration,
their app-role GUIDs, and why existing connections keep working through the
amber **Approve new permissions** banner instead of stopping — is in
[Customer Graph Read manifest v3](./m365-customer-graph-read-manifest-v3.md).

The only sync-specific consequence: a domain whose scope has not been approved
yet stays `needs_consent` and is simply not scheduled. Every other domain keeps
running on the old grants, and turning sync on does not force the re-consent to
happen any sooner.

### 2. Set the environment variables

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `M365_TENANT_SYNC_ENABLED` | API | `false` | Master switch. Gates **every** entry point: the ticker, consent seeding, the on-demand route, and the disconnect hook's seeding side. Leave it off until you have read the deploy doc. |
| `M365_SYNC_CONCURRENCY` | API | `4` | Sync jobs processed per API instance. |
| `M365_SYNC_MAX_BACKLOG` | API | `500` | Queue depth above which the ticker sheds a tick rather than piling on. |
| `M365_SYNC_TICK_BATCH` | API | `200` | Rows claimed per 60-second tick. This is the capacity dial. |
| `M365_SYNC_MAX_IN_FLIGHT` | executor | `4` | Concurrent sync pulls per executor instance. |
| `M365_MAX_IN_FLIGHT` | executor | `32` | Total concurrent operations per executor instance; sync may use at most the sync cap out of this, so interactive AI-tool calls always keep headroom. |
| `M365_SIGNIN_ACTIVITY_RPM` | executor | `4` | Token bucket for sign-in-activity Graph requests. Microsoft limits these to **10 per minute per application across all tenants** — divide this value across regions and replicas that share one app registration. |
| `M365_SIGNIN_PAGES_PER_CALL` | executor | `5` | Pages per sign-in call before returning a continuation. |

Sync and interactive calls share one executor origin
(`M365_GRAPH_READ_EXECUTOR_URL`); there is no separate sync-executor URL. The
two routes are isolated by their independent caps, timeouts and metrics.

## Deployment

1. Deploy the database migration and the API together. The migration creates
   seven tables and adds one unique index to `m365_connections`; it creates no
   rows and takes no long lock.
2. Deploy the web UI and the executor.
3. Leave `M365_TENANT_SYNC_ENABLED=false` and confirm the stack is healthy.
   The upgrade-consent banner appears at this point, independently of the sync
   flag.
4. Turn `M365_TENANT_SYNC_ENABLED=true` on **one** region. No manual seeding is
   needed: the ticker's reconciliation step inserts sync-state rows for every
   executable connection that lacks them, staggered over the first hour, with
   the first Secure Score run backfilling 90 days of history.
5. Watch `m365_sync_ticker_utilisation`, `m365_sync_due_backlog`, the
   executor's `503 sync_capacity` counter, and database latency for one full
   cadence window (six hours) before enabling the second region.

## Verification

```sql
-- Every executable connection has six sync-state rows.
SELECT c.org_id, count(s.domain) AS domains
FROM m365_connections c
LEFT JOIN m365_sync_state s ON (s.connection_id, s.org_id) = (c.id, c.org_id)
WHERE c.profile = 'customer-graph-read' AND c.status IN ('active','degraded')
GROUP BY c.org_id HAVING count(s.domain) <> 6;
```

Zero rows means reconciliation has caught up. Domains that legitimately stay
unscheduled show `next_sync_at IS NULL` with `last_status = 'needs_consent'`;
they are still rows, so they do not appear in the query above.

## Rollback

Set `M365_TENANT_SYNC_ENABLED=false`. The ticker stops claiming, in-flight
jobs finish or are fenced harmlessly, and everything already stored stays
readable. **Keep the tables and the migration**; dropping them discards Secure
Score history, which cannot be regenerated (Graph serves only the recent
window). Manifest version 3 and the upgrade-consent route are independent of
the flag and should not be rolled back — a connection already promoted to v3
keeps working either way.
