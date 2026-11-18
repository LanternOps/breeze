-- #8170 W06.2b: admit the Bitdefender GravityZone framework vendor in coverage rows.
-- Without it every coverage row for the vendor is refused, and because rows are
-- inserted in chunks of 1000, a refused row drops the other vendors' rows in its chunk.
-- The vendor stays dormant (enableable: false), so no row names it yet.
-- DDL only: no row writes, so no breeze.scope election. SECURITY_AGENT_STATUS_VENDORS
-- mirrors this list (securityAgentStatusVendorBitdefender.migration.test.ts).

ALTER TABLE security_agent_device_status DROP CONSTRAINT IF EXISTS security_agent_device_status_vendor_chk;
ALTER TABLE security_agent_device_status ADD CONSTRAINT security_agent_device_status_vendor_chk
  CHECK (vendor IN ('huntress', 'sentinelone', 'controld', 'nextdns', 'bitdefender'));
