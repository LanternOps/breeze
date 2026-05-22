-- Built-in SNMP templates for Ubiquiti UniFi devices.
--
-- UniFi devices (switches, APs, USG/UDM gateways) respond to SNMP v2c when
-- enabled in the UniFi controller. They expose mostly standard MIB-2 +
-- HOST-RESOURCES-MIB + BRIDGE-MIB + POE-MIB. The vendor-specific OID prefix
-- is .1.3.6.1.4.1.41112 (Ubiquiti Networks Inc.) but the most useful data
-- for monitoring lives in the standard MIBs.
--
-- Templates are scoped with org_id=NULL + is_built_in=true so every org sees
-- them. Idempotent: re-applying matches on (name, is_built_in=true) and skips.

DO $$
BEGIN
  -- ============================================================
  -- 1. Ubiquiti UniFi Switch (USW series, including POE variants)
  -- ============================================================
  IF NOT EXISTS (
    SELECT 1 FROM snmp_templates
    WHERE name = 'Ubiquiti UniFi Switch' AND is_built_in = true
  ) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in)
    VALUES (
      NULL,
      'Ubiquiti UniFi Switch',
      'Standard monitoring for UniFi switches (USW series): system identity, interface table for traffic + errors, bridge MAC table, POE port status. Enable SNMP v2c on the device with a read-only community before polling.',
      'Ubiquiti',
      'switch',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",        "name": "sysDescr",                "type": "string",   "description": "System description (model + firmware)"},
        {"oid": "1.3.6.1.2.1.1.2.0",        "name": "sysObjectID",             "type": "oid",      "description": "Vendor-assigned object ID"},
        {"oid": "1.3.6.1.2.1.1.3.0",        "name": "sysUpTime",               "type": "timeticks","description": "Uptime in hundredths of a second"},
        {"oid": "1.3.6.1.2.1.1.5.0",        "name": "sysName",                 "type": "string",   "description": "Configured device name"},
        {"oid": "1.3.6.1.2.1.1.6.0",        "name": "sysLocation",             "type": "string",   "description": "Configured location"},
        {"oid": "1.3.6.1.2.1.2.1.0",        "name": "ifNumber",                "type": "integer",  "description": "Number of interfaces"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",      "name": "ifDescr",                 "type": "table",    "description": "Interface descriptions (walk)"},
        {"oid": "1.3.6.1.2.1.2.2.1.5",      "name": "ifSpeed",                 "type": "table",    "description": "Interface bandwidth bits/sec (walk)"},
        {"oid": "1.3.6.1.2.1.2.2.1.7",      "name": "ifAdminStatus",           "type": "table",    "description": "Admin status: 1=up 2=down 3=testing"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",      "name": "ifOperStatus",            "type": "table",    "description": "Operational status (walk)"},
        {"oid": "1.3.6.1.2.1.2.2.1.10",     "name": "ifInOctets",              "type": "counter",  "description": "Per-interface inbound bytes"},
        {"oid": "1.3.6.1.2.1.2.2.1.16",     "name": "ifOutOctets",             "type": "counter",  "description": "Per-interface outbound bytes"},
        {"oid": "1.3.6.1.2.1.2.2.1.14",     "name": "ifInErrors",              "type": "counter",  "description": "Per-interface inbound errors"},
        {"oid": "1.3.6.1.2.1.2.2.1.20",     "name": "ifOutErrors",             "type": "counter",  "description": "Per-interface outbound errors"},
        {"oid": "1.3.6.1.2.1.17.1.1.0",     "name": "dot1dBaseBridgeAddress",  "type": "string",   "description": "Bridge MAC address"},
        {"oid": "1.3.6.1.2.1.17.1.2.0",     "name": "dot1dBaseNumPorts",       "type": "integer",  "description": "Number of bridge ports"},
        {"oid": "1.3.6.1.2.1.17.4.3.1.1",   "name": "dot1dTpFdbAddress",       "type": "table",    "description": "MAC address forwarding table (walk)"},
        {"oid": "1.3.6.1.2.1.17.4.3.1.2",   "name": "dot1dTpFdbPort",          "type": "table",    "description": "Port number for each FDB entry"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.3",  "name": "pethPsePortAdminEnable",  "type": "table",    "description": "POE port admin enable (1=true 2=false)"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.6",  "name": "pethPsePortDetectionStatus","type":"table",   "description": "POE detection: 1=disabled 3=delivering 4=fault"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.10", "name": "pethPsePortPowerClass",   "type": "table",    "description": "IEEE 802.3af class (0-4)"}
      ]'::jsonb,
      true
    );
  END IF;

  -- ============================================================
  -- 2. Ubiquiti UniFi Access Point (UAP / U6 series)
  -- ============================================================
  IF NOT EXISTS (
    SELECT 1 FROM snmp_templates
    WHERE name = 'Ubiquiti UniFi Access Point' AND is_built_in = true
  ) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in)
    VALUES (
      NULL,
      'Ubiquiti UniFi Access Point',
      'Standard monitoring for UniFi APs (UAP, U6, U7 series): system identity, uplink interface traffic, system uptime, CPU + memory via HOST-RESOURCES-MIB. UniFi exposes limited wireless data via SNMP; richer wireless telemetry comes from the UniFi controller API.',
      'Ubiquiti',
      'access_point',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",       "name": "sysDescr",            "type": "string",   "description": "System description (UniFi AP model + firmware)"},
        {"oid": "1.3.6.1.2.1.1.2.0",       "name": "sysObjectID",         "type": "oid",      "description": "Vendor-assigned object ID"},
        {"oid": "1.3.6.1.2.1.1.3.0",       "name": "sysUpTime",           "type": "timeticks","description": "Uptime in hundredths of a second"},
        {"oid": "1.3.6.1.2.1.1.5.0",       "name": "sysName",             "type": "string",   "description": "Configured device name"},
        {"oid": "1.3.6.1.2.1.1.6.0",       "name": "sysLocation",         "type": "string",   "description": "Configured location"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",     "name": "ifDescr",             "type": "table",    "description": "Interface descriptions (uplink + radio interfaces)"},
        {"oid": "1.3.6.1.2.1.2.2.1.5",     "name": "ifSpeed",             "type": "table",    "description": "Per-interface bandwidth"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",     "name": "ifOperStatus",        "type": "table",    "description": "Operational status"},
        {"oid": "1.3.6.1.2.1.2.2.1.10",    "name": "ifInOctets",          "type": "counter",  "description": "Per-interface inbound bytes"},
        {"oid": "1.3.6.1.2.1.2.2.1.16",    "name": "ifOutOctets",         "type": "counter",  "description": "Per-interface outbound bytes"},
        {"oid": "1.3.6.1.2.1.2.2.1.14",    "name": "ifInErrors",          "type": "counter",  "description": "Inbound errors per interface"},
        {"oid": "1.3.6.1.2.1.2.2.1.20",    "name": "ifOutErrors",         "type": "counter",  "description": "Outbound errors per interface"},
        {"oid": "1.3.6.1.2.1.25.1.1.0",    "name": "hrSystemUptime",      "type": "timeticks","description": "Host resources system uptime"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.5",  "name": "hrStorageSize",       "type": "table",    "description": "Storage size in allocation units"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.6",  "name": "hrStorageUsed",       "type": "table",    "description": "Storage used in allocation units"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",  "name": "hrProcessorLoad",     "type": "table",    "description": "CPU load 0-100 percent (per processor)"}
      ]'::jsonb,
      true
    );
  END IF;

  -- ============================================================
  -- 3. Ubiquiti UniFi Gateway (USG / UDM / UDM-Pro / Dream Router)
  -- ============================================================
  IF NOT EXISTS (
    SELECT 1 FROM snmp_templates
    WHERE name = 'Ubiquiti UniFi Gateway' AND is_built_in = true
  ) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in)
    VALUES (
      NULL,
      'Ubiquiti UniFi Gateway',
      'Standard monitoring for UniFi gateways (USG, UDM, UDM-Pro, Dream Router, Dream Machine SE): interface traffic + errors on WAN/LAN, IP forwarding counters, host CPU + memory + storage. SNMP must be enabled in the controller before polling.',
      'Ubiquiti',
      'router',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",       "name": "sysDescr",          "type": "string",   "description": "System description (USG/UDM model + EdgeOS/UniFi OS version)"},
        {"oid": "1.3.6.1.2.1.1.2.0",       "name": "sysObjectID",       "type": "oid",      "description": "Vendor-assigned object ID"},
        {"oid": "1.3.6.1.2.1.1.3.0",       "name": "sysUpTime",         "type": "timeticks","description": "Uptime"},
        {"oid": "1.3.6.1.2.1.1.5.0",       "name": "sysName",           "type": "string",   "description": "Configured device name"},
        {"oid": "1.3.6.1.2.1.1.6.0",       "name": "sysLocation",       "type": "string",   "description": "Configured location"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",     "name": "ifDescr",           "type": "table",    "description": "Interface names (eth0, eth1, ...)"},
        {"oid": "1.3.6.1.2.1.2.2.1.5",     "name": "ifSpeed",           "type": "table",    "description": "Per-interface bandwidth"},
        {"oid": "1.3.6.1.2.1.2.2.1.7",     "name": "ifAdminStatus",     "type": "table",    "description": "Admin status"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",     "name": "ifOperStatus",      "type": "table",    "description": "Operational status"},
        {"oid": "1.3.6.1.2.1.2.2.1.10",    "name": "ifInOctets",        "type": "counter",  "description": "Inbound bytes per interface"},
        {"oid": "1.3.6.1.2.1.2.2.1.16",    "name": "ifOutOctets",       "type": "counter",  "description": "Outbound bytes per interface"},
        {"oid": "1.3.6.1.2.1.2.2.1.13",    "name": "ifInDiscards",      "type": "counter",  "description": "Inbound discards"},
        {"oid": "1.3.6.1.2.1.2.2.1.14",    "name": "ifInErrors",        "type": "counter",  "description": "Inbound errors"},
        {"oid": "1.3.6.1.2.1.2.2.1.19",    "name": "ifOutDiscards",     "type": "counter",  "description": "Outbound discards"},
        {"oid": "1.3.6.1.2.1.2.2.1.20",    "name": "ifOutErrors",       "type": "counter",  "description": "Outbound errors"},
        {"oid": "1.3.6.1.2.1.4.1.0",       "name": "ipForwarding",      "type": "integer",  "description": "1=forwarding gateway 2=host-only"},
        {"oid": "1.3.6.1.2.1.4.3.0",       "name": "ipInReceives",      "type": "counter",  "description": "Total IP packets received"},
        {"oid": "1.3.6.1.2.1.4.10.0",      "name": "ipOutRequests",     "type": "counter",  "description": "Total IP packets sent"},
        {"oid": "1.3.6.1.2.1.25.1.1.0",    "name": "hrSystemUptime",    "type": "timeticks","description": "Host resources system uptime"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.5",  "name": "hrStorageSize",     "type": "table",    "description": "Storage allocation units"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.6",  "name": "hrStorageUsed",     "type": "table",    "description": "Storage used allocation units"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",  "name": "hrProcessorLoad",   "type": "table",    "description": "CPU load 0-100 percent per core"}
      ]'::jsonb,
      true
    );
  END IF;
END $$;
