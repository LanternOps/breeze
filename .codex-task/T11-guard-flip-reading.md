# T11 real-DB regression: guard-flip reading (not executed)

Docker and real-DB integration execution are prohibited for this run. This is a
source-level proof of the regression assertions, not a claim of DB test success.

File: `apps/api/src/__tests__/integration/topologySiteAlertOriginDeviceDeletion.integration.test.ts`.
The parameterized preservation test has two cases: same-org origin (`false`) and
an origin moved through the real move-org route (`true`). The third test retains
GDPR erasure's deletion behavior. Fixtures explicitly classify topology/device
owners and use generic names.

## Guards and assertion failures if flipped

1. Restore HEAD's `deleteOriginDeviceTopologyAlerts` call in deviceDeletion.ts.
   Its unchanged shared implementation deletes correlations, notifications, PSA
   mappings and the topology alert. Both preservation cases would find no owned
   row: `expect(preserved).toMatchObject({ deviceId: null, ... })` fails; retained
   notification/correlation/mapping assertions fail too. The device-owned control
   continues to disappear, so this distinguishes ownership rather than disabling
   the device cascade.
2. Remove the new detach UPDATE or change its owner guard to `device`.
   The topology row still references the origin; the generic registered alerts
   DELETE by device_id removes it. The same preserved-row assertion fails (or
   the invalid null-device device-owner row fails alerts_owner_chk and rolls
   back the route). Both are observable failures rather than silent survival.
3. Remove PSA mapping detachment or change its guard to `owner_kind = 'device'`.
   The topology mapping fixture names BOTH the preserved topology alert and the
   deleted device. The explicit `OR device_id = ...` cleanup deletes it; the
   registered generic mapping DELETE independently reaches it too. The expected
   preserved mapping `{ alertId: ownedId, deviceId: null }` assertion fails.
   Device-owned and standalone mapping deletion assertions ensure the fix does
   not preserve unrelated device mappings.
4. Include the surviving topology alert in deviceAlertIds (e.g. by selecting
   topology_site owners without the device guard). Its retained notification
   and correlation assertions fail. Runtime ordering detaches before child
   cleanup, and unit tests independently pin the device-owner-only subquery
   and emission order for notifications, correlations, and PSA mappings.
5. Route the org-erasure pre-clear through the detach function.
   The existing GDPR case expects the foreign topology alert and notification
   to be gone and `foreignTopologyAlertsDeleted === 1`; those assertions fail.
   This run instead leaves tenantCascade.ts and both delete function bodies
   byte-for-byte unchanged from HEAD (mechanically compared). The new helper
   unit test also pins the old helper's six destructive statements and org
   exclusion; the tenant cascade unit suites are included in the green sweep.
6. Leave the route or bulk audit field named removedTopologyAlerts.
   The real-DB preservation cases expect detachedTopologyAlerts = 1. Unit tests
   assert positive counts through deletion, lifecycle, route, and bulk worker;
   the red run observed those failures before implementation.

## DB constraint and visibility reading

- W1 made alerts.device_id nullable and the topology_site CHECK arm permits
  null provenance while retaining topology_site_id; no migration is needed.
- The topology ownership guard watches org_id/topology_site_id/source_key, not
  provenance-only device_id changes; site ownership and source keys stay intact.
- PSA mapping device_id is nullable with a NO ACTION device FK. Clearing only
  that pointer preserves its alert and external ticket identity.
- The real permanent-delete route runs the cascade in a system context after
  locking the device; the moved-origin test reads the foreign owner row through
  the integration seed connection and asserts it stays with its original site
  and org. Caller context is not broadened by this patch.

CI must execute the real-DB suite plus tenantCascade.integration.test.ts and
installBoundaryContract.integration.test.ts. No Postgres, Redis, Docker stack,
server, or background CI poller was started locally.
