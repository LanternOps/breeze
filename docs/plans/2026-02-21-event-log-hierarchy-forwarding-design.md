# Design: Event Log Hierarchy Resolution + Elasticsearch Forwarding

**Date:** 2026-02-21
**Status:** Approved

## Problem

Event log collection settings currently resolve at the org level only. An MSP managing hundreds of devices per org has no way to tune collection differently for a noisy server group versus quiet workstations. Additionally, larger orgs need to forward collected logs to Elasticsearch/OpenSearch for advanced search, visualization, and long-term analysis.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Forwarding config location | Org-level settings | Forwarding is a plumbing decision, not per-device |
| Initial sink types | Elasticsearch/OpenSearch only | Most value; webhook/syslog added later |
| Caching strategy | Per-device Redis (2-min TTL) | Simple, ~5MB at 10k devices, sufficient |
| Delivery mechanism | BullMQ async forwarder | Decouples ingestion from ES availability |
| Collection detail changes | Deferred to Tier 2 | Custom log sources, channels, file tailing later |

## Part 1: Full Hierarchy Resolution

### Current State

`getDeviceEventLogSettings(orgId)` queries org-level assignments only:
```
assignments WHERE level='organization' AND targetId=orgId
  → policies (active) → feature_links (event_log) → event_log_settings
```

### Target State

`getDeviceEventLogSettings(deviceId)` uses `resolveEffectiveConfig(deviceId)` which walks the full hierarchy:
```
device (priority 5) → device_groups (4) → site (3) → org (2) → partner (1)
```
First match per feature type wins ("closest wins").

### Data Flow

```
Heartbeat arrives
  → Redis GET eventlog:settings:device:{deviceId}
  → miss? → resolveEffectiveConfig(deviceId)
    → walks hierarchy, extracts event_log feature
    → assembleInlineSettings() → EventLogSettings object
    → Redis SET with 2-min TTL
  → return settings for heartbeat response + ingestion enforcement
```

### Changes Required

| Component | Change |
|-----------|--------|
| `getDeviceEventLogSettings()` | Accept `deviceId` instead of `orgId`; call `resolveEffectiveConfig` |
| Cache key | `eventlog:settings:org:{orgId}` → `eventlog:settings:device:{deviceId}` |
| Cache TTL | 5 min → 2 min (more granular = shorter cache) |
| Heartbeat route | Pass `device.id` instead of `device.orgId` |
| Ingestion route | Pass `device.id` instead of `device.orgId` |
| Retention job | Stays org-level (storage concern, not collection) |
| Agent code | No changes |
| Frontend | No changes |
| Schema/validators | No changes |

### Performance

- 10k devices × 60s heartbeat = ~167 heartbeats/sec
- 2-min cache TTL → each device hits DB every ~2 heartbeats = ~83 queries/sec
- `resolveEffectiveConfig` is a single query with 5 joins — indexed on all join columns
- ~5MB Redis memory for 10k cached settings

## Part 2: Elasticsearch Forwarding

### Architecture

```
Agent → POST /eventlogs → write to PG (always, source of truth)
                         → enqueue to BullMQ "log-forwarding" queue
                              ↓
                         Log Forwarding Worker
                              → batch 100-500 events per _bulk request
                              → POST /_bulk to Elasticsearch
                              → retry with exponential backoff
                              → dead-letter after 5 retries
```

### Org-Level Settings

Stored in org `settings` JSONB column (existing pattern for mTLS settings):

```typescript
{
  logForwarding: {
    enabled: boolean;
    elasticsearchUrl: string;       // https://my-es-cluster:9200
    elasticsearchApiKey?: string;   // API key auth (preferred)
    elasticsearchUsername?: string;  // Basic auth fallback
    elasticsearchPassword?: string;
    indexPrefix: string;            // Default: "breeze-logs"
    // Index: {indexPrefix}-{YYYY.MM.dd}
  }
}
```

### New Components

| File | Purpose |
|------|---------|
| `services/logForwarding.ts` | ES client, bulk index, connection pool per org |
| `jobs/logForwardingWorker.ts` | BullMQ worker, batching, retry, dead-letter |
| Org settings endpoint | `PATCH /api/orgs/:orgId/settings/log-forwarding` |
| Zod validator | `orgLogForwardingSettingsSchema` in shared validators |

### Forwarding Worker Design

- **Queue**: `log-forwarding`, one job per event log batch submission
- **Job data**: `{ orgId, deviceId, events: EventLogRow[] }`
- **Worker**: Looks up org forwarding settings, bulk-indexes to ES
- **Batching**: Accumulates events, flushes at 500 events or 5-second window
- **Retry**: Exponential backoff (1s, 2s, 4s, 8s, 16s), dead-letter after 5 attempts
- **Backpressure**: If queue depth > 10k, log warning and skip enqueueing (PG still has the data)
- **Feature flag**: If org has no forwarding config or `enabled: false`, skip enqueueing entirely

### Elasticsearch Index Template

```json
{
  "index_patterns": ["breeze-logs-*"],
  "template": {
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 1,
      "index.lifecycle.name": "breeze-logs-policy"
    },
    "mappings": {
      "properties": {
        "deviceId": { "type": "keyword" },
        "orgId": { "type": "keyword" },
        "hostname": { "type": "keyword" },
        "category": { "type": "keyword" },
        "level": { "type": "keyword" },
        "source": { "type": "keyword" },
        "message": { "type": "text" },
        "timestamp": { "type": "date" },
        "rawData": { "type": "object", "enabled": false }
      }
    }
  }
}
```

### Security

- ES credentials stored encrypted in org settings (same pattern as other secrets)
- API key auth preferred over basic auth
- Connection over HTTPS enforced (reject http:// URLs)
- No agent-side changes — agents never talk to ES directly

## What's NOT Included (YAGNI)

- Custom log sources / Windows Event Log channels (Tier 2)
- Webhook / syslog sinks (add as additional sink types later)
- Per-device forwarding rules (org-level only)
- Real-time streaming (batch via BullMQ sufficient)
- Tiered storage / hot-warm-cold (PG stays single source of truth)
- Kibana dashboard provisioning
- CDC / Debezium
