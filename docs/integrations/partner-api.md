# Breeze Partner API v1

The partner API is a read-only, service-principal-authenticated export of durable reconstruction facts. The complete setup, key-rotation, recovery, and endpoint reference will be added with the partner API operational rollout.

## Foundational device group membership

`GET /api/v1/partner-api/devices` includes a bounded, deterministic group-membership summary on each device:

```json
{
  "groupIds": ["00000000-0000-4000-8000-000000000001"],
  "groupMembership": {
    "total": 1,
    "included": 1,
    "complete": true,
    "reason": null
  }
}
```

- `groupIds` contains at most 500 group UUIDs in ascending UUID order.
- `total` is the complete membership count at export time; `included` is the number present in `groupIds`.
- `complete` is true exactly when `included === total`.
- When a device has more than 500 memberships, `complete` is false and `reason` is exactly `membership_limit_exceeded`. Consumers must treat the omitted memberships as an explicit completeness gap, not as absence or deletion.
- Group membership inserts, updates, and deletes advance the device export timestamp, so membership-only changes reappear in incremental device traversals.

The paginated `device-relationships` resource provides the unbounded relationship contract in the advanced reconstruction phase. Consumers that receive `membership_limit_exceeded` should use that resource for the complete group-edge set once enabled.

## Cursor filter binding

Every signed v1 cursor binds the traversal to its exact material filters. The signed payload contains a strict `filters` object:

```json
{
  "filters": {
    "orgId": null,
    "siteId": null
  }
}
```

`orgId` is bound for every foundational resource. `siteId` is additionally bound for devices and is always `null` for organizations and sites. Adding, removing, or changing either filter while reusing a cursor returns `400 invalid_partner_export_cursor`; the traversal never silently restarts.
