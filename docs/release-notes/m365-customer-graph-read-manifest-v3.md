# Microsoft 365 Customer Graph Read permission manifest v3

## Action required

This release raises the `customer-graph-read` permission manifest from version 2 to version 3, adding four Microsoft Graph application permissions that the Microsoft 365 tenant-sync features need:

| Permission | Unlocks |
|---|---|
| `Policy.Read.All` | Conditional Access policies and named locations |
| `RoleManagement.Read.Directory` | Directory role assignments and admin counts |
| `SecurityEvents.Read.All` | Microsoft Secure Score and control profiles |
| `AuditLogsQuery.Read.All` | Unified audit log queries |

All four are added in a single bump so each customer administrator re-consents once rather than once per feature.

**Existing connections keep working.** A connection consented under v2 continues to serve every read it served before, on the grants it already holds. It is reported as `manifest-stale` and shows an amber banner in **Settings → Integrations**: "New Microsoft 365 permissions are required for Conditional Access, Secure Score, and admin role visibility. A Global Administrator must approve them." Selecting **Approve new permissions** starts a Microsoft admin-consent flow that leaves the connection executable throughout — if the administrator abandons or cancels it, nothing changes.

**Self-hosters who run their own Customer Graph Read application registration must add the four app roles before their customers' administrators can approve them.** The exact app role IDs are in `docs/deploy/m365-customer-graph-read-executor.md` under "Entra application and permission manifest". Until they are added, the banner appears but the consent cannot complete.

Breeze-hosted customers need no action beyond having a Global Administrator approve the banner.

## Deployment

1. Deploy the database migration and API together. The migration adds one column with a default (`m365_consent_sessions.purpose`) and takes no lock beyond a brief `ACCESS EXCLUSIVE` on a small table.
2. Confirm that the API and migration are healthy.
3. Deploy the web UI.
4. Self-hosters: add the four app roles to the Customer Graph Read application registration.
5. Ask each customer's Global Administrator to complete **Approve new permissions**.

There is no ordering hazard between the API and the web UI: the banner is derived server-side and simply does not render until the API ships.

## Verification

Run the following as a database administrator after deployment. It lists connections still on the old manifest — expected to be non-empty until administrators approve, and expected to shrink as they do.

```sql
SELECT id, org_id, tenant_id, display_name, permission_manifest_version, status
FROM m365_connections
WHERE profile = 'customer-graph-read'
  AND status IN ('active', 'degraded')
  AND permission_manifest_version < 3
ORDER BY display_name;
```

Every row in that list must still be `active` or `degraded` — never `pending-consent`. A `customer-graph-read` connection sitting in `pending-consent` after an upgrade attempt would mean the upgrade path wrote a status it must never write; treat it as a defect and re-consent the connection through **Re-consent**.

After a successful approval, the connection's `permission_manifest_version` is 3, its `consent_generation` has increased by one, and `grants_verified_at` is refreshed.

## Rollback

If the application deployment must be rolled back:

- Keep the `m365_consent_sessions.purpose` column. It defaults to `initial`, which is exactly how the previous release's code treats every session.
- Connections already promoted to manifest v3 keep working on the older code: `deriveGrantHealth` compares against whatever manifest that build carries, so a v3 row against a v2 build reports `manifest-stale` and continues serving reads.
- Do not remove the four app roles from the application registration. Extra granted roles are reported as `unexpected` on the card, not as a failure, and removing them would break any connection already promoted.
