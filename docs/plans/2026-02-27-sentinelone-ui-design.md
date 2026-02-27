# SentinelOne Integration UI — Design

## Scope

Setup-only UI under Settings > Integrations as a new "Security" tab. Covers connection management, sync status, and S1 Site-to-Breeze Organization mapping.

## Files

### New
- `apps/web/src/components/integrations/SecurityIntegration.tsx` — React component
- `apps/web/src/pages/settings/integrations/security.astro` — Astro page
- `apps/api/src/db/schema/sentinelOne.ts` — add `s1SiteMappings` table
- `apps/api/src/db/migrations/2026-02-27-s1-site-mappings.sql` — migration

### Modified
- `apps/web/src/components/integrations/IntegrationsPage.tsx` — add Security tab
- `apps/web/src/components/integrations/index.ts` — add export
- `apps/api/src/routes/sentinelOne.ts` — add sites/map endpoints

## UI Sections

### 1. Connection Setup Card
- Name (text), Management URL (url), API Token (password with show/hide)
- Test Connection button (GET /sentinelOne/status with current creds)
- Save button (POST /sentinelOne/integration — upsert, MFA-gated)
- MFA required note

### 2. Connection Status Card (visible when integration exists)
- Status badge: Connected (green) / Syncing (amber) / Error (red) / Not configured (gray)
- Last sync time + status
- Last sync error (if any)
- Sync Now button (POST /sentinelOne/sync)
- Active/Inactive toggle

### 3. Site-to-Organization Mapping (visible after first sync)
Table of distinct S1 site names with:
- Site name
- Agent count per site
- Dropdown to select Breeze Organization
- Per-row save
- Warning indicator for unmapped sites

### 4. Coverage Summary (visible when integration exists)
- Total agents synced
- Mapped to Breeze devices
- Infected agents
- Active threats
- Pending actions

## Backend Changes

### New table: `s1_site_mappings`
```sql
CREATE TABLE s1_site_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES s1_integrations(id),
  site_name VARCHAR(200) NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(integration_id, site_name)
);
```

### New endpoint: GET /sentinelOne/sites
Returns distinct site names from synced agents with agent counts and current mapping.
```json
{
  "data": [
    { "siteName": "Acme Corp", "agentCount": 47, "mappedOrgId": "uuid-or-null", "mappedOrgName": "Acme" },
    { "siteName": "Beta LLC", "agentCount": 12, "mappedOrgId": null, "mappedOrgName": null }
  ]
}
```

### New endpoint: POST /sentinelOne/sites/map
Saves or removes a site-to-org mapping.
```json
{ "integrationId": "uuid", "siteName": "Acme Corp", "orgId": "uuid-or-null" }
```

## Data Flow

1. Mount: GET /sentinelOne/integration — load config or null
2. If exists: GET /sentinelOne/status — load summary
3. If exists: GET /sentinelOne/sites — load site mappings
4. Save config: POST /sentinelOne/integration
5. Sync: POST /sentinelOne/sync
6. Map site: POST /sentinelOne/sites/map

## Patterns

- Astro Islands: `client:load` directive, DashboardLayout wrapper
- API calls: `fetchWithAuth()` from auth store
- State: Pure React hooks (no external store)
- Styling: Tailwind only, lucide-react icons
- Status badges: emerald/amber/slate color system from IntegrationsPage
- Cards: `rounded-xl border bg-card p-6 shadow-sm`

## IntegrationsPage Changes

Add `security` category to `integrationCatalog`:
- id: `'security'`, label: `'Security'`, icon: `Shield`
- description: `'Endpoint detection and response integrations.'`
- cta: `'Add security'`
- One card for SentinelOne with dynamic status
