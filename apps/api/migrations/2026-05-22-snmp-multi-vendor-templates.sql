-- Multi-vendor built-in SNMP templates.
--
-- Extends the UniFi templates from 2026-05-22-unifi-snmp-templates.sql with
-- coverage for the most common gear in MSP fleets:
--   * Generic Printer (RFC 3805 Printer-MIB)        — HP, Brother, Lexmark, Xerox, Canon, etc.
--   * Cisco IOS Switch / Router / ASA               — most common managed switching gear
--   * Fortinet FortiGate                            — popular SMB/MSP firewall
--   * SonicWall                                     — common SMB firewall
--   * MikroTik RouterOS                             — routers + APs
--   * Aruba / HPE ProCurve Switch                   — enterprise/edu/SMB switching
--   * Synology NAS / QNAP NAS                       — common NAS gear in MSP fleets
--   * APC UPS (PowerNet MIB)                        — most common SmartUPS
--   * Generic UPS (RFC 1628 UPS-MIB)                — Eaton, CyberPower, Tripp Lite
--   * Linux net-snmpd (Generic Server)              — any Linux box with snmpd
--   * pfSense / OPNsense (BSD net-snmpd)            — BSD-based firewalls
--   * VMware ESXi                                   — basic SNMP host metrics
--
-- All OIDs are sourced from documented standard MIBs (RFC 3805, RFC 1628,
-- RFC 4188, RFC 3621, HOST-RESOURCES-MIB) and published vendor MIBs
-- (Cisco, Fortinet, MikroTik, Synology, QNAP, APC PowerNet, VMware).
--
-- Idempotent: re-applying matches on (name, is_built_in=true) and skips.

DO $$
BEGIN
  -- ========================================================================
  -- 1. Generic Printer (RFC 3805 Printer-MIB)
  -- ========================================================================
  -- Covers HP LaserJet/OfficeJet, Brother, Lexmark, Xerox, Canon, Epson —
  -- any printer shipped in the last 15 years implements Printer-MIB.
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Generic Printer (RFC 3805)' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Generic Printer (RFC 3805)',
      'Standards-based printer monitoring via RFC 3805 Printer-MIB. Works with HP LaserJet/OfficeJet/PageWide, Brother, Lexmark, Xerox, Canon, Epson, Kyocera, Ricoh — any printer shipped in the last 15 years. Reports toner/ink levels, paper input tray status, page counts, error states. Pair with HOST-RESOURCES-MIB for printer status.',
      NULL, 'printer',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",          "name": "sysDescr",                   "type": "string",   "description": "Printer model + firmware"},
        {"oid": "1.3.6.1.2.1.1.5.0",          "name": "sysName",                    "type": "string",   "description": "Configured device name"},
        {"oid": "1.3.6.1.2.1.1.6.0",          "name": "sysLocation",                "type": "string",   "description": "Physical location"},
        {"oid": "1.3.6.1.2.1.25.3.2.1.5",     "name": "hrDeviceStatus",             "type": "table",    "description": "1=unknown 2=running 3=warning 4=testing 5=down"},
        {"oid": "1.3.6.1.2.1.25.3.5.1.1",     "name": "hrPrinterStatus",            "type": "table",    "description": "1=other 2=unknown 3=idle 4=printing 5=warmup"},
        {"oid": "1.3.6.1.2.1.25.3.5.1.2",     "name": "hrPrinterDetectedErrorState","type": "table",    "description": "Bitmask of error conditions (paper jam, low toner, etc.)"},
        {"oid": "1.3.6.1.2.1.43.5.1.1.16",    "name": "prtGeneralPrinterName",      "type": "table",    "description": "Vendor-assigned printer name"},
        {"oid": "1.3.6.1.2.1.43.5.1.1.17",    "name": "prtGeneralSerialNumber",     "type": "table",    "description": "Serial number"},
        {"oid": "1.3.6.1.2.1.43.8.2.1.10",    "name": "prtInputCurrentLevel",       "type": "table",    "description": "Sheets remaining per input tray"},
        {"oid": "1.3.6.1.2.1.43.8.2.1.13",    "name": "prtInputName",               "type": "table",    "description": "Input tray name"},
        {"oid": "1.3.6.1.2.1.43.10.2.1.4",    "name": "prtMarkerLifeCount",         "type": "table",    "description": "Lifetime page count"},
        {"oid": "1.3.6.1.2.1.43.10.2.1.5",    "name": "prtMarkerPowerOnCount",      "type": "table",    "description": "Pages since power-on"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.5",    "name": "prtMarkerSuppliesType",      "type": "table",    "description": "Toner/ink type per supply"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.6",    "name": "prtMarkerSuppliesDescription","type": "table",   "description": "Vendor description (e.g., Cyan Toner)"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.8",    "name": "prtMarkerSuppliesMaxCapacity","type": "table",   "description": "Max capacity"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.9",    "name": "prtMarkerSuppliesLevel",     "type": "table",    "description": "Current level (negative = unknown)"},
        {"oid": "1.3.6.1.2.1.43.12.1.1.4",    "name": "prtMarkerColorantValue",     "type": "table",    "description": "Color name per supply"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 2. Cisco IOS Switch (Catalyst series)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Cisco IOS Switch' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Cisco IOS Switch',
      'Cisco Catalyst / IOS-XE switches. Covers system identity, interface counters with high-capacity ifXTable (64-bit counters), CPU + memory via CISCO-PROCESS-MIB / CISCO-MEMORY-POOL-MIB, environmental sensors via CISCO-ENVMON-MIB, bridge MAC table, POE.',
      'Cisco', 'switch',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string",   "description": "IOS version + model"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks","description": "Uptime"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string",   "description": "Hostname"},
        {"oid": "1.3.6.1.2.1.1.6.0",                "name": "sysLocation",           "type": "string",   "description": "Location"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table",    "description": "Interface name (e.g. GigabitEthernet1/0/1)"},
        {"oid": "1.3.6.1.2.1.2.2.1.5",              "name": "ifSpeed",               "type": "table",    "description": "Interface bandwidth bits/sec"},
        {"oid": "1.3.6.1.2.1.2.2.1.7",              "name": "ifAdminStatus",         "type": "table",    "description": "Admin status"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",          "type": "table",    "description": "Operational status"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64","description": "64-bit inbound bytes (use over ifInOctets for gig+ links)"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64","description": "64-bit outbound bytes"},
        {"oid": "1.3.6.1.2.1.2.2.1.14",             "name": "ifInErrors",            "type": "counter",  "description": "Inbound errors"},
        {"oid": "1.3.6.1.2.1.2.2.1.20",             "name": "ifOutErrors",           "type": "counter",  "description": "Outbound errors"},
        {"oid": "1.3.6.1.2.1.17.1.1.0",             "name": "dot1dBaseBridgeAddress","type": "string",   "description": "Bridge MAC"},
        {"oid": "1.3.6.1.2.1.17.4.3.1.1",           "name": "dot1dTpFdbAddress",     "type": "table",    "description": "MAC forwarding table"},
        {"oid": "1.3.6.1.2.1.17.4.3.1.2",           "name": "dot1dTpFdbPort",        "type": "table",    "description": "Port for each FDB entry"},
        {"oid": "1.3.6.1.4.1.9.9.109.1.1.1.1.7",    "name": "cpmCPUTotal1minRev",    "type": "table",    "description": "Cisco 1-min CPU avg (per CPU index)"},
        {"oid": "1.3.6.1.4.1.9.9.109.1.1.1.1.8",    "name": "cpmCPUTotal5minRev",    "type": "table",    "description": "Cisco 5-min CPU avg"},
        {"oid": "1.3.6.1.4.1.9.9.48.1.1.1.5",       "name": "ciscoMemoryPoolUsed",   "type": "table",    "description": "Bytes used per memory pool"},
        {"oid": "1.3.6.1.4.1.9.9.48.1.1.1.6",       "name": "ciscoMemoryPoolFree",   "type": "table",    "description": "Bytes free per memory pool"},
        {"oid": "1.3.6.1.4.1.9.9.13.1.3.1.3",       "name": "ciscoEnvMonTemperatureValue","type":"table","description": "Temperature sensors (degrees C)"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.3",          "name": "pethPsePortAdminEnable","type": "table",    "description": "POE port admin"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.6",          "name": "pethPsePortDetectionStatus","type":"table", "description": "POE detection status"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 3. Cisco IOS Router (ISR / 8000 series + standalone routers)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Cisco IOS Router' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Cisco IOS Router',
      'Cisco ISR / 4000 / 8000 series routers and standalone routers on IOS / IOS-XE. Adds IP forwarding counters on top of the Cisco IOS Switch template baseline.',
      'Cisco', 'router',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.5",              "name": "ifSpeed",               "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",          "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64"},
        {"oid": "1.3.6.1.2.1.2.2.1.14",             "name": "ifInErrors",            "type": "counter"},
        {"oid": "1.3.6.1.2.1.2.2.1.20",             "name": "ifOutErrors",           "type": "counter"},
        {"oid": "1.3.6.1.2.1.4.1.0",                "name": "ipForwarding",          "type": "integer",  "description": "1=router 2=host"},
        {"oid": "1.3.6.1.2.1.4.3.0",                "name": "ipInReceives",          "type": "counter",  "description": "Total IP packets received"},
        {"oid": "1.3.6.1.2.1.4.10.0",               "name": "ipOutRequests",         "type": "counter",  "description": "Total IP packets sent"},
        {"oid": "1.3.6.1.4.1.9.9.109.1.1.1.1.7",    "name": "cpmCPUTotal1minRev",    "type": "table"},
        {"oid": "1.3.6.1.4.1.9.9.109.1.1.1.1.8",    "name": "cpmCPUTotal5minRev",    "type": "table"},
        {"oid": "1.3.6.1.4.1.9.9.48.1.1.1.5",       "name": "ciscoMemoryPoolUsed",   "type": "table"},
        {"oid": "1.3.6.1.4.1.9.9.48.1.1.1.6",       "name": "ciscoMemoryPoolFree",   "type": "table"},
        {"oid": "1.3.6.1.4.1.9.9.13.1.3.1.3",       "name": "ciscoEnvMonTemperatureValue","type":"table"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 4. Cisco ASA Firewall (5500-X series)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Cisco ASA Firewall' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Cisco ASA Firewall',
      'Cisco ASA 5500-X series firewalls. Includes CISCO-FIREWALL-MIB connection counters + standard MIB-2 interface stats. ASA exposes most metrics under cfwSystem (cisco.firewall).',
      'Cisco', 'firewall',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",          "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64"},
        {"oid": "1.3.6.1.4.1.9.9.109.1.1.1.1.7",    "name": "cpmCPUTotal1minRev",    "type": "table"},
        {"oid": "1.3.6.1.4.1.9.9.109.1.1.1.1.8",    "name": "cpmCPUTotal5minRev",    "type": "table"},
        {"oid": "1.3.6.1.4.1.9.9.48.1.1.1.5",       "name": "ciscoMemoryPoolUsed",   "type": "table"},
        {"oid": "1.3.6.1.4.1.9.9.48.1.1.1.6",       "name": "ciscoMemoryPoolFree",   "type": "table"},
        {"oid": "1.3.6.1.4.1.9.9.147.1.2.2.2.1.5",  "name": "cfwConnectionStatValue","type": "table",    "description": "ASA connection statistics (current, max, etc.)"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 5. Fortinet FortiGate
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Fortinet FortiGate' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Fortinet FortiGate',
      'FortiGate firewalls (all models, FortiOS 6.x+). Covers system identity + version, CPU/memory/disk via FORTINET-FORTIGATE-MIB, active session count (key SMB metric), HA state, interface stats.',
      'Fortinet', 'firewall',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",          "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64"},
        {"oid": "1.3.6.1.4.1.12356.101.4.1.1.0",    "name": "fgSysVersion",          "type": "string",   "description": "FortiOS version"},
        {"oid": "1.3.6.1.4.1.12356.101.4.1.3.0",    "name": "fgSysCpuUsage",         "type": "integer",  "description": "CPU usage %"},
        {"oid": "1.3.6.1.4.1.12356.101.4.1.4.0",    "name": "fgSysMemUsage",         "type": "integer",  "description": "Memory usage %"},
        {"oid": "1.3.6.1.4.1.12356.101.4.1.5.0",    "name": "fgSysMemCapacity",      "type": "integer",  "description": "Total memory KB"},
        {"oid": "1.3.6.1.4.1.12356.101.4.1.6.0",    "name": "fgSysDiskUsage",        "type": "integer",  "description": "Log disk usage MB"},
        {"oid": "1.3.6.1.4.1.12356.101.4.1.7.0",    "name": "fgSysDiskCapacity",     "type": "integer",  "description": "Log disk capacity MB"},
        {"oid": "1.3.6.1.4.1.12356.101.4.1.8.0",    "name": "fgSysSesCount",         "type": "integer",  "description": "Active session count (key SMB metric)"},
        {"oid": "1.3.6.1.4.1.12356.101.13.1.1.0",   "name": "fgHaSystemMode",        "type": "integer",  "description": "HA mode: 1=standalone 2=active-passive 3=active-active"},
        {"oid": "1.3.6.1.4.1.12356.101.13.1.2.0",   "name": "fgHaGroupName",         "type": "string",   "description": "HA group name"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 6. SonicWall Firewall (TZ / NSA / NSv series)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'SonicWall Firewall' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'SonicWall Firewall',
      'SonicWall TZ / NSA / NSv series firewalls. SonicWall SNMP is sparse beyond standard MIB-2; this template focuses on the well-documented system identity + connection cache OIDs.',
      'SonicWall', 'firewall',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",          "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64"},
        {"oid": "1.3.6.1.4.1.8741.1.1.1.1.0",       "name": "sonicCurrentFirmwareVersion","type":"string","description": "SonicOS version"},
        {"oid": "1.3.6.1.4.1.8741.1.1.4.1.0",       "name": "sonicMaxConnCacheEntries","type": "integer","description": "Max connections cache size"},
        {"oid": "1.3.6.1.4.1.8741.1.1.4.2.0",       "name": "sonicCurrentConnCacheEntries","type":"integer","description": "Current connection count"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 7. MikroTik RouterOS
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'MikroTik RouterOS' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'MikroTik RouterOS',
      'MikroTik routers, switches, and APs running RouterOS. Covers system identity, interface stats, MikroTik health monitoring (CPU temp, board temp, voltage), and firmware version.',
      'MikroTik', 'router',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",          "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",           "name": "hrProcessorLoad",       "type": "table",    "description": "CPU load %"},
        {"oid": "1.3.6.1.4.1.14988.1.1.3.10.0",     "name": "mtxrHlTemperature",     "type": "integer",  "description": "Device temperature (deci-degrees C)"},
        {"oid": "1.3.6.1.4.1.14988.1.1.3.11.0",     "name": "mtxrHlCpuTemperature",  "type": "integer",  "description": "CPU temperature (deci-degrees C)"},
        {"oid": "1.3.6.1.4.1.14988.1.1.3.6.0",      "name": "mtxrHlBoardTemperature","type": "integer",  "description": "Board temperature"},
        {"oid": "1.3.6.1.4.1.14988.1.1.3.2.0",      "name": "mtxrHlVoltage",         "type": "integer",  "description": "Voltage (deci-volts)"},
        {"oid": "1.3.6.1.4.1.14988.1.1.7.4.0",      "name": "mtxrFirmwareVersion",   "type": "string",   "description": "RouterOS version"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 8. Aruba / HPE ProCurve Switch
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Aruba / HPE ProCurve Switch' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Aruba / HPE ProCurve Switch',
      'Aruba and legacy HPE ProCurve switches (running ArubaOS-CX or ProCurve OS). Uses standard MIB-2 + BRIDGE-MIB + POE-MIB for the bulk; Aruba enterprise OIDs vary by product line so only well-documented ones included.',
      'Aruba', 'switch',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.1.6.0",                "name": "sysLocation",           "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.5",              "name": "ifSpeed",               "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",          "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64"},
        {"oid": "1.3.6.1.2.1.2.2.1.14",             "name": "ifInErrors",            "type": "counter"},
        {"oid": "1.3.6.1.2.1.2.2.1.20",             "name": "ifOutErrors",           "type": "counter"},
        {"oid": "1.3.6.1.2.1.17.1.1.0",             "name": "dot1dBaseBridgeAddress","type": "string"},
        {"oid": "1.3.6.1.2.1.17.4.3.1.1",           "name": "dot1dTpFdbAddress",     "type": "table"},
        {"oid": "1.3.6.1.2.1.17.4.3.1.2",           "name": "dot1dTpFdbPort",        "type": "table"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.3",          "name": "pethPsePortAdminEnable","type": "table"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.6",          "name": "pethPsePortDetectionStatus","type":"table"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",           "name": "hrProcessorLoad",       "type": "table"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 9. Synology DSM (NAS)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Synology DSM (NAS)' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Synology DSM (NAS)',
      'Synology NAS appliances running DSM 6.x/7.x. Covers system identity, temperature, fan status, disk health table, RAID status, network interface counters.',
      'Synology', 'nas',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",           "name": "hrProcessorLoad",       "type": "table",    "description": "CPU load per processor"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.5",           "name": "hrStorageSize",         "type": "table",    "description": "Storage size in alloc units"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.6",           "name": "hrStorageUsed",         "type": "table",    "description": "Storage used in alloc units"},
        {"oid": "1.3.6.1.4.1.6574.1.1.0",           "name": "synoSystemStatus",      "type": "integer",  "description": "1=normal 2=fail"},
        {"oid": "1.3.6.1.4.1.6574.1.2.0",           "name": "synoTemperature",       "type": "integer",  "description": "System temp (C)"},
        {"oid": "1.3.6.1.4.1.6574.1.3.0",           "name": "synoPowerStatus",       "type": "integer",  "description": "1=normal 2=fail"},
        {"oid": "1.3.6.1.4.1.6574.1.4.0",           "name": "synoSystemFanStatus",   "type": "integer",  "description": "1=normal 2=fail"},
        {"oid": "1.3.6.1.4.1.6574.1.5.0",           "name": "synoCPUFanStatus",      "type": "integer",  "description": "1=normal 2=fail"},
        {"oid": "1.3.6.1.4.1.6574.1.5.1.0",         "name": "synoModelName",         "type": "string",   "description": "DiskStation/RackStation model"},
        {"oid": "1.3.6.1.4.1.6574.2.1.1.2",         "name": "synoDiskID",            "type": "table",    "description": "Disk slot identifier"},
        {"oid": "1.3.6.1.4.1.6574.2.1.1.3",         "name": "synoDiskModel",         "type": "table",    "description": "Disk model string"},
        {"oid": "1.3.6.1.4.1.6574.2.1.1.5",         "name": "synoDiskStatus",        "type": "table",    "description": "1=normal 2=initialized 3=notInit 4=systemPartFail 5=crash"},
        {"oid": "1.3.6.1.4.1.6574.2.1.1.6",         "name": "synoDiskTemperature",   "type": "table",    "description": "Disk temp (C)"},
        {"oid": "1.3.6.1.4.1.6574.3.1.1.2",         "name": "synoRaidName",          "type": "table",    "description": "Volume name"},
        {"oid": "1.3.6.1.4.1.6574.3.1.1.3",         "name": "synoRaidStatus",        "type": "table",    "description": "RAID status"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 10. QNAP QTS (NAS)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'QNAP QTS (NAS)' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'QNAP QTS (NAS)',
      'QNAP NAS appliances on QTS/QuTS Hero. QNAP SNMP relies primarily on standard MIB-2 + HOST-RESOURCES-MIB plus net-snmpd extensions; QNAP enterprise OIDs are sparse and inconsistent across firmware so this template stays standards-based.',
      'QNAP', 'nas',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64"},
        {"oid": "1.3.6.1.2.1.25.1.1.0",             "name": "hrSystemUptime",        "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.25.2.2.0",             "name": "hrMemorySize",          "type": "integer",  "description": "Total RAM KB"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.3",           "name": "hrStorageDescr",        "type": "table",    "description": "Volume description"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.5",           "name": "hrStorageSize",         "type": "table",    "description": "Volume size in alloc units"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.6",           "name": "hrStorageUsed",         "type": "table",    "description": "Volume used in alloc units"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",           "name": "hrProcessorLoad",       "type": "table",    "description": "CPU load per processor"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 11. APC UPS (PowerNet MIB)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'APC UPS (PowerNet)' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'APC UPS (PowerNet)',
      'APC SmartUPS / Smart-UPS X / Symmetra series via PowerNet MIB. Battery state, runtime remaining, on-battery time, output load %, line voltage, temperature, model.',
      'APC', 'ups',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.1.1.1.0",    "name": "upsBasicIdentModel",    "type": "string",   "description": "UPS model"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.1.1.2.0",    "name": "upsBasicIdentName",     "type": "string",   "description": "Configured UPS name"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.2.1.1.0",    "name": "upsBasicBatteryStatus", "type": "integer",  "description": "1=unknown 2=normal 3=low 4=in_fault"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.2.1.2.0",    "name": "upsBasicBatteryTimeOnBattery","type":"timeticks","description":"Time on battery"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.2.2.1.0",    "name": "upsAdvBatteryCapacity", "type": "integer",  "description": "Battery charge %"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.2.2.2.0",    "name": "upsAdvBatteryTemperature","type":"integer", "description": "Battery temp (C)"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.2.2.3.0",    "name": "upsAdvBatteryRunTimeRemaining","type":"timeticks","description":"Estimated runtime"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.4.1.1.0",    "name": "upsBasicOutputStatus",  "type": "integer",  "description": "2=online 3=onBattery 4=onSmartBoost 5=timed 6=software 7=hardware 8=sleep"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.4.2.1.0",    "name": "upsAdvOutputVoltage",   "type": "integer",  "description": "Output voltage V"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.4.2.3.0",    "name": "upsAdvOutputLoad",      "type": "integer",  "description": "Output load %"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.3.2.1.0",    "name": "upsAdvInputLineVoltage","type": "integer",  "description": "Input line voltage V"},
        {"oid": "1.3.6.1.4.1.318.1.1.1.3.2.4.0",    "name": "upsAdvInputFrequency",  "type": "integer",  "description": "Input frequency Hz"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 12. Generic UPS (RFC 1628)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Generic UPS (RFC 1628)' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Generic UPS (RFC 1628)',
      'Standards-based UPS monitoring via RFC 1628 UPS-MIB. Works with Eaton, CyberPower, Tripp Lite, Vertiv, Liebert, and any UPS implementing UPS-MIB. Battery status, line voltage, output load, runtime.',
      NULL, 'ups',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.33.1.1.1.0",           "name": "upsIdentManufacturer",  "type": "string"},
        {"oid": "1.3.6.1.2.1.33.1.1.2.0",           "name": "upsIdentModel",         "type": "string"},
        {"oid": "1.3.6.1.2.1.33.1.1.3.0",           "name": "upsIdentAgentSoftwareVersion","type":"string"},
        {"oid": "1.3.6.1.2.1.33.1.1.5.0",           "name": "upsIdentName",          "type": "string"},
        {"oid": "1.3.6.1.2.1.33.1.2.1.0",           "name": "upsBatteryStatus",      "type": "integer",  "description": "1=unknown 2=normal 3=low 4=depleted"},
        {"oid": "1.3.6.1.2.1.33.1.2.2.0",           "name": "upsSecondsOnBattery",   "type": "integer",  "description": "Seconds on battery (0 = on line)"},
        {"oid": "1.3.6.1.2.1.33.1.2.3.0",           "name": "upsEstimatedMinutesRemaining","type":"integer","description": "Runtime remaining"},
        {"oid": "1.3.6.1.2.1.33.1.2.4.0",           "name": "upsEstimatedChargeRemaining","type":"integer","description":"Charge %"},
        {"oid": "1.3.6.1.2.1.33.1.2.7.0",           "name": "upsBatteryTemperature", "type": "integer",  "description": "Battery temp (C)"},
        {"oid": "1.3.6.1.2.1.33.1.3.2.0",           "name": "upsInputNumLines",      "type": "integer"},
        {"oid": "1.3.6.1.2.1.33.1.3.3.1.3",         "name": "upsInputVoltage",       "type": "table"},
        {"oid": "1.3.6.1.2.1.33.1.3.3.1.2",         "name": "upsInputFrequency",     "type": "table"},
        {"oid": "1.3.6.1.2.1.33.1.4.1.0",           "name": "upsOutputSource",       "type": "integer",  "description": "1=other 2=none 3=normal 4=bypass 5=battery 6=booster 7=reducer"},
        {"oid": "1.3.6.1.2.1.33.1.4.4.1.2",         "name": "upsOutputVoltage",      "type": "table"},
        {"oid": "1.3.6.1.2.1.33.1.4.4.1.5",         "name": "upsOutputPercentLoad",  "type": "table"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 13. Linux net-snmpd (Generic Server)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Linux net-snmpd' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Linux net-snmpd',
      'Generic Linux server running the net-snmp daemon. Covers system identity, interface stats, HOST-RESOURCES-MIB (CPU/memory/storage), running processes, software inventory, UCD-SNMP-MIB load averages.',
      NULL, 'server',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string",   "description": "Kernel + distro"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64"},
        {"oid": "1.3.6.1.2.1.25.1.1.0",             "name": "hrSystemUptime",        "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.25.1.5.0",             "name": "hrSystemNumUsers",      "type": "integer",  "description": "Logged-in users"},
        {"oid": "1.3.6.1.2.1.25.1.6.0",             "name": "hrSystemProcesses",     "type": "integer",  "description": "Running processes"},
        {"oid": "1.3.6.1.2.1.25.2.2.0",             "name": "hrMemorySize",          "type": "integer",  "description": "Total RAM KB"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.3",           "name": "hrStorageDescr",        "type": "table",    "description": "Mount/storage description"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.5",           "name": "hrStorageSize",         "type": "table"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.6",           "name": "hrStorageUsed",         "type": "table"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",           "name": "hrProcessorLoad",       "type": "table",    "description": "Per-CPU load %"},
        {"oid": "1.3.6.1.4.1.2021.10.1.3.1",        "name": "laLoad1min",            "type": "string",   "description": "UCD 1-minute load avg"},
        {"oid": "1.3.6.1.4.1.2021.10.1.3.2",        "name": "laLoad5min",            "type": "string",   "description": "UCD 5-minute load avg"},
        {"oid": "1.3.6.1.4.1.2021.10.1.3.3",        "name": "laLoad15min",           "type": "string",   "description": "UCD 15-minute load avg"},
        {"oid": "1.3.6.1.4.1.2021.4.5.0",           "name": "memTotalReal",          "type": "integer",  "description": "Total RAM KB (UCD)"},
        {"oid": "1.3.6.1.4.1.2021.4.6.0",           "name": "memAvailReal",          "type": "integer",  "description": "Available RAM KB"},
        {"oid": "1.3.6.1.4.1.2021.4.11.0",          "name": "memTotalFree",          "type": "integer",  "description": "Total free memory"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 14. pfSense / OPNsense (BSD net-snmpd)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'pfSense / OPNsense' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'pfSense / OPNsense',
      'BSD-based firewall distributions running bsnmpd. Covers system identity, interface stats with high-capacity counters, host-resources MIB for CPU + memory + storage, UCD load averages, IP forwarding counters.',
      'Netgate', 'firewall',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.5",              "name": "ifSpeed",               "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",          "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64"},
        {"oid": "1.3.6.1.2.1.4.1.0",                "name": "ipForwarding",          "type": "integer"},
        {"oid": "1.3.6.1.2.1.4.3.0",                "name": "ipInReceives",          "type": "counter"},
        {"oid": "1.3.6.1.2.1.4.10.0",               "name": "ipOutRequests",         "type": "counter"},
        {"oid": "1.3.6.1.2.1.25.1.1.0",             "name": "hrSystemUptime",        "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.25.2.2.0",             "name": "hrMemorySize",          "type": "integer"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.5",           "name": "hrStorageSize",         "type": "table"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.6",           "name": "hrStorageUsed",         "type": "table"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",           "name": "hrProcessorLoad",       "type": "table"},
        {"oid": "1.3.6.1.4.1.2021.10.1.3.1",        "name": "laLoad1min",            "type": "string"},
        {"oid": "1.3.6.1.4.1.2021.10.1.3.2",        "name": "laLoad5min",            "type": "string"},
        {"oid": "1.3.6.1.4.1.2021.10.1.3.3",        "name": "laLoad15min",           "type": "string"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 15. VMware ESXi Host
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'VMware ESXi Host' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'VMware ESXi Host',
      'VMware ESXi 6.5+ hypervisor SNMP exposure. Modern ESXi has reduced SNMP coverage in favor of the vCenter API; this template covers what is still exposed: product version, hardware identity, system uptime, basic interface stats.',
      'VMware', 'server',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",              "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",             "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",               "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",               "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",          "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",          "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",         "type": "counter64"},
        {"oid": "1.3.6.1.2.1.25.1.1.0",             "name": "hrSystemUptime",        "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.25.2.2.0",             "name": "hrMemorySize",          "type": "integer"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.5",           "name": "hrStorageSize",         "type": "table"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.6",           "name": "hrStorageUsed",         "type": "table"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",           "name": "hrProcessorLoad",       "type": "table"},
        {"oid": "1.3.6.1.4.1.6876.1.1.0",           "name": "vmwProductName",        "type": "string",   "description": "Product name"},
        {"oid": "1.3.6.1.4.1.6876.1.2.0",           "name": "vmwProductVersion",     "type": "string",   "description": "ESXi version"},
        {"oid": "1.3.6.1.4.1.6876.1.3.0",           "name": "vmwProductBuild",       "type": "string",   "description": "Build number"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 16. Juniper Networks (JUNOS — switches, routers, SRX firewalls)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Juniper JUNOS' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Juniper JUNOS',
      'Juniper switches (EX series), routers (MX, ACX, PTX), and SRX firewalls running JUNOS. Uses JUNIPER-MIB jnxOperating* table for chassis/CPU/memory/temperature sensors and jnxBoxAnatomy for hardware inventory.',
      'Juniper', 'switch',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",               "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                 "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",                 "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",            "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",            "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",           "type": "counter64"},
        {"oid": "1.3.6.1.4.1.2636.3.1.2.0",         "name": "jnxBoxDescr",             "type": "string",  "description": "Chassis description"},
        {"oid": "1.3.6.1.4.1.2636.3.1.3.0",         "name": "jnxBoxSerialNo",          "type": "string",  "description": "Chassis serial"},
        {"oid": "1.3.6.1.4.1.2636.3.1.4.0",         "name": "jnxBoxRevision",          "type": "string",  "description": "Chassis revision"},
        {"oid": "1.3.6.1.4.1.2636.3.1.13.1.5",      "name": "jnxOperatingDescr",       "type": "table",   "description": "Operating component descriptions"},
        {"oid": "1.3.6.1.4.1.2636.3.1.13.1.7",      "name": "jnxOperatingTemp",        "type": "table",   "description": "Temperature (C) per component"},
        {"oid": "1.3.6.1.4.1.2636.3.1.13.1.8",      "name": "jnxOperatingCPU",         "type": "table",   "description": "CPU utilization % per component"},
        {"oid": "1.3.6.1.4.1.2636.3.1.13.1.11",     "name": "jnxOperatingMemory",      "type": "table",   "description": "Memory used per component (kB)"},
        {"oid": "1.3.6.1.4.1.2636.3.1.13.1.15",     "name": "jnxOperatingBuffer",      "type": "table",   "description": "Buffer pool used %"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 17. Dell Networking (PowerSwitch / Force10 / OS10)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Dell Networking PowerSwitch' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Dell Networking PowerSwitch',
      'Dell Networking PowerSwitch / Force10 / OS10 switches. Dell enterprise OID layout differs across product lines (S-series, N-series, Z-series) so this template stays standards-based on MIB-2 + BRIDGE-MIB + POE-MIB; per-line vendor enrichment is a follow-up.',
      'Dell', 'switch',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",               "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                 "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",                 "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.5",              "name": "ifSpeed",                 "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",            "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",            "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",           "type": "counter64"},
        {"oid": "1.3.6.1.2.1.2.2.1.14",             "name": "ifInErrors",              "type": "counter"},
        {"oid": "1.3.6.1.2.1.2.2.1.20",             "name": "ifOutErrors",             "type": "counter"},
        {"oid": "1.3.6.1.2.1.17.1.1.0",             "name": "dot1dBaseBridgeAddress",  "type": "string"},
        {"oid": "1.3.6.1.2.1.17.4.3.1.1",           "name": "dot1dTpFdbAddress",       "type": "table"},
        {"oid": "1.3.6.1.2.1.17.4.3.1.2",           "name": "dot1dTpFdbPort",          "type": "table"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.3",          "name": "pethPsePortAdminEnable",  "type": "table"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.6",          "name": "pethPsePortDetectionStatus","type":"table"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 18. HP/HPE ProLiant Server (iLO + Insight Manager)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'HPE ProLiant Server (iLO)' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'HPE ProLiant Server (iLO)',
      'HPE ProLiant servers with iLO 4/5/6 + Insight Agent. Uses CPQHLTH-MIB (1.3.6.1.4.1.232.6) for temperature/fans/power, CPQHOST-MIB for system info. Requires iLO SNMP enabled.',
      'HPE', 'server',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",               "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                 "type": "string"},
        {"oid": "1.3.6.1.2.1.25.2.2.0",             "name": "hrMemorySize",            "type": "integer"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.5",           "name": "hrStorageSize",           "type": "table"},
        {"oid": "1.3.6.1.2.1.25.2.3.1.6",           "name": "hrStorageUsed",           "type": "table"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",           "name": "hrProcessorLoad",         "type": "table"},
        {"oid": "1.3.6.1.4.1.232.2.2.2.1.0",        "name": "cpqSiServerSerialNumber", "type": "string",  "description": "Server serial"},
        {"oid": "1.3.6.1.4.1.232.2.2.4.2.0",        "name": "cpqSiProductName",        "type": "string",  "description": "ProLiant model"},
        {"oid": "1.3.6.1.4.1.232.6.2.6.4.0",        "name": "cpqHeThermalSystemStatus","type": "integer", "description": "1=other 2=ok 3=degraded 4=failed"},
        {"oid": "1.3.6.1.4.1.232.6.2.6.8.1.4",      "name": "cpqHeTemperatureCurrent", "type": "table",   "description": "Temperature per sensor (C)"},
        {"oid": "1.3.6.1.4.1.232.6.2.6.7.1.9",      "name": "cpqHeFltTolFanCondition", "type": "table",   "description": "Fan condition: 2=ok 3=degraded 4=failed"},
        {"oid": "1.3.6.1.4.1.232.6.2.9.3.1.4",      "name": "cpqHeFltTolPowerSupplyCondition","type":"table","description": "PSU condition"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 19. Dell PowerEdge Server (iDRAC + OpenManage)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Dell PowerEdge (iDRAC)' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Dell PowerEdge (iDRAC)',
      'Dell PowerEdge servers with iDRAC 7/8/9 and OpenManage Server Administrator. Uses Dell IDRAC-MIB-SMIv2 (1.3.6.1.4.1.674.10892) for chassis health, temperature, fans, power, disk array status.',
      'Dell', 'server',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",               "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                 "type": "string"},
        {"oid": "1.3.6.1.2.1.25.2.2.0",             "name": "hrMemorySize",            "type": "integer"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",           "name": "hrProcessorLoad",         "type": "table"},
        {"oid": "1.3.6.1.4.1.674.10892.5.1.3.2.0",  "name": "drsProductShortName",     "type": "string",  "description": "PowerEdge model"},
        {"oid": "1.3.6.1.4.1.674.10892.5.1.3.3.0",  "name": "drsProductChassisServiceTag","type":"string","description": "Service tag"},
        {"oid": "1.3.6.1.4.1.674.10892.5.4.200.10.1.4","name": "systemStateChassisStatus","type":"table","description": "Chassis status: 1=other 2=unknown 3=ok 4=non-critical 5=critical 6=non-recoverable"},
        {"oid": "1.3.6.1.4.1.674.10892.5.4.700.20.1.6","name": "temperatureProbeReading","type":"table","description": "Temperature (tenths of C)"},
        {"oid": "1.3.6.1.4.1.674.10892.5.4.700.12.1.6","name": "coolingDeviceReading", "type": "table",  "description": "Fan RPM"},
        {"oid": "1.3.6.1.4.1.674.10892.5.4.600.12.1.5","name": "powerSupplyOutputWatts","type":"table",  "description": "PSU output watts"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 20. Lenovo ThinkSystem (XCC / IMM)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Lenovo ThinkSystem (XCC)' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Lenovo ThinkSystem (XCC)',
      'Lenovo ThinkSystem servers with XClarity Controller (XCC) or IBM IMM. Vendor enterprise OID 1.3.6.1.4.1.19046; this template uses well-documented identity + system-health OIDs and falls back to standards for the rest.',
      'Lenovo', 'server',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",               "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                 "type": "string"},
        {"oid": "1.3.6.1.2.1.25.2.2.0",             "name": "hrMemorySize",            "type": "integer"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",           "name": "hrProcessorLoad",         "type": "table"},
        {"oid": "1.3.6.1.4.1.19046.11.1.1.1.1.0",   "name": "systemHealthStat",        "type": "integer", "description": "0=normal 2=non-critical 4=critical"},
        {"oid": "1.3.6.1.4.1.19046.11.1.1.1.2.0",   "name": "systemHealthSummary",     "type": "string",  "description": "Summary text"},
        {"oid": "1.3.6.1.4.1.19046.11.1.1.2.1.0",   "name": "machineLevelProductName", "type": "string",  "description": "Lenovo product name"},
        {"oid": "1.3.6.1.4.1.19046.11.1.1.2.2.0",   "name": "machineLevelMachineType", "type": "string",  "description": "Machine type"},
        {"oid": "1.3.6.1.4.1.19046.11.1.1.2.6.0",   "name": "machineLevelSerialNumber","type": "string",  "description": "Serial number"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 21. Netgear ProSAFE Smart Switch
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Netgear ProSAFE Switch' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Netgear ProSAFE Switch',
      'Netgear ProSAFE Smart and Managed switches (GS-series, M-series, S-series). Netgear enterprise OID layout varies across model generations; this template stays on the standards-based MIB-2 + BRIDGE-MIB + POE-MIB baseline that all of them implement.',
      'Netgear', 'switch',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",               "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                 "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",                 "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.5",              "name": "ifSpeed",                 "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",            "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",            "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",           "type": "counter64"},
        {"oid": "1.3.6.1.2.1.17.1.1.0",             "name": "dot1dBaseBridgeAddress",  "type": "string"},
        {"oid": "1.3.6.1.2.1.17.4.3.1.1",           "name": "dot1dTpFdbAddress",       "type": "table"},
        {"oid": "1.3.6.1.2.1.17.4.3.1.2",           "name": "dot1dTpFdbPort",          "type": "table"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.3",          "name": "pethPsePortAdminEnable",  "type": "table"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.6",          "name": "pethPsePortDetectionStatus","type":"table"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 22. TP-Link Omada Switch
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'TP-Link Omada Switch' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'TP-Link Omada Switch',
      'TP-Link Omada (T-series / TL-SG-series) managed switches. TP-Link enterprise OIDs vary by model so the template stays standards-based; richer telemetry is in the Omada Controller API.',
      'TP-Link', 'switch',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",               "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                 "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",                 "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.5",              "name": "ifSpeed",                 "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",            "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",            "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",           "type": "counter64"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.3",          "name": "pethPsePortAdminEnable",  "type": "table"},
        {"oid": "1.3.6.1.2.1.105.1.1.1.6",          "name": "pethPsePortDetectionStatus","type":"table"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 23. Brother Printer (enrichment over RFC 3805)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Brother Printer' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Brother Printer',
      'Brother HL/MFC/DCP printers. Brother implements RFC 3805 Printer-MIB cleanly so the Generic Printer template covers ~95% of monitoring needs. This template inherits the same OID set; pick it for clearer vendor labelling in the device list.',
      'Brother', 'printer',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                  "type": "string"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                   "type": "string"},
        {"oid": "1.3.6.1.2.1.25.3.2.1.5",           "name": "hrDeviceStatus",            "type": "table"},
        {"oid": "1.3.6.1.2.1.25.3.5.1.1",           "name": "hrPrinterStatus",           "type": "table"},
        {"oid": "1.3.6.1.2.1.25.3.5.1.2",           "name": "hrPrinterDetectedErrorState","type":"table"},
        {"oid": "1.3.6.1.2.1.43.5.1.1.17",          "name": "prtGeneralSerialNumber",    "type": "table"},
        {"oid": "1.3.6.1.2.1.43.8.2.1.10",          "name": "prtInputCurrentLevel",      "type": "table"},
        {"oid": "1.3.6.1.2.1.43.8.2.1.13",          "name": "prtInputName",              "type": "table"},
        {"oid": "1.3.6.1.2.1.43.10.2.1.4",          "name": "prtMarkerLifeCount",        "type": "table",   "description": "Lifetime page count"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.6",          "name": "prtMarkerSuppliesDescription","type":"table"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.8",          "name": "prtMarkerSuppliesMaxCapacity","type":"table"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.9",          "name": "prtMarkerSuppliesLevel",    "type": "table"},
        {"oid": "1.3.6.1.2.1.43.12.1.1.4",          "name": "prtMarkerColorantValue",    "type": "table"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 24. Lexmark Printer (enrichment over RFC 3805)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Lexmark Printer' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Lexmark Printer',
      'Lexmark MS/MX/CS/CX printers. Standards-compliant Printer-MIB implementation; vendor enterprise OID 1.3.6.1.4.1.641 exists but most useful telemetry is in standard Printer-MIB OIDs.',
      'Lexmark', 'printer',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                  "type": "string"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                   "type": "string"},
        {"oid": "1.3.6.1.2.1.25.3.2.1.5",           "name": "hrDeviceStatus",            "type": "table"},
        {"oid": "1.3.6.1.2.1.25.3.5.1.1",           "name": "hrPrinterStatus",           "type": "table"},
        {"oid": "1.3.6.1.2.1.25.3.5.1.2",           "name": "hrPrinterDetectedErrorState","type":"table"},
        {"oid": "1.3.6.1.2.1.43.5.1.1.17",          "name": "prtGeneralSerialNumber",    "type": "table"},
        {"oid": "1.3.6.1.2.1.43.8.2.1.10",          "name": "prtInputCurrentLevel",      "type": "table"},
        {"oid": "1.3.6.1.2.1.43.10.2.1.4",          "name": "prtMarkerLifeCount",        "type": "table"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.6",          "name": "prtMarkerSuppliesDescription","type":"table"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.8",          "name": "prtMarkerSuppliesMaxCapacity","type":"table"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.9",          "name": "prtMarkerSuppliesLevel",    "type": "table"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 25. Eaton UPS (Eaton XUPS MIB)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Eaton UPS' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Eaton UPS',
      'Eaton 5P/5PX/9PX/9SX UPS units. Most Eaton UPS implement both RFC 1628 (preferred) and the XUPS MIB (1.3.6.1.4.1.534); this template uses RFC 1628 for portability with a few XUPS extensions.',
      'Eaton', 'ups',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",               "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                 "type": "string"},
        {"oid": "1.3.6.1.2.1.33.1.1.1.0",           "name": "upsIdentManufacturer",    "type": "string"},
        {"oid": "1.3.6.1.2.1.33.1.1.2.0",           "name": "upsIdentModel",           "type": "string"},
        {"oid": "1.3.6.1.2.1.33.1.2.1.0",           "name": "upsBatteryStatus",        "type": "integer"},
        {"oid": "1.3.6.1.2.1.33.1.2.2.0",           "name": "upsSecondsOnBattery",     "type": "integer"},
        {"oid": "1.3.6.1.2.1.33.1.2.3.0",           "name": "upsEstimatedMinutesRemaining","type":"integer"},
        {"oid": "1.3.6.1.2.1.33.1.2.4.0",           "name": "upsEstimatedChargeRemaining","type":"integer"},
        {"oid": "1.3.6.1.2.1.33.1.2.7.0",           "name": "upsBatteryTemperature",   "type": "integer"},
        {"oid": "1.3.6.1.2.1.33.1.3.3.1.3",         "name": "upsInputVoltage",         "type": "table"},
        {"oid": "1.3.6.1.2.1.33.1.4.1.0",           "name": "upsOutputSource",         "type": "integer"},
        {"oid": "1.3.6.1.2.1.33.1.4.4.1.5",         "name": "upsOutputPercentLoad",    "type": "table"},
        {"oid": "1.3.6.1.4.1.534.1.6.5.0",          "name": "xupsTopologyUnitDescription","type":"string", "description": "Eaton XUPS unit description"},
        {"oid": "1.3.6.1.4.1.534.1.1.2.0",          "name": "xupsIdentManufacturer",   "type": "string"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 26. CyberPower UPS
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'CyberPower UPS' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'CyberPower UPS',
      'CyberPower PR/OR/OL series UPS with RMCARD network management. CyberPower CPS-MIB (1.3.6.1.4.1.3808) provides identity, battery, and load metrics; RFC 1628 is also implemented as a fallback.',
      'CyberPower', 'ups',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",               "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                 "type": "string"},
        {"oid": "1.3.6.1.4.1.3808.1.1.1.1.1.1.0",   "name": "upsBaseIdentModel",       "type": "string"},
        {"oid": "1.3.6.1.4.1.3808.1.1.1.1.2.1.0",   "name": "upsBaseSystemStatus",     "type": "integer"},
        {"oid": "1.3.6.1.4.1.3808.1.1.1.2.1.1.0",   "name": "upsBatteryStatus",        "type": "integer", "description": "1=unknown 2=normal 3=low 4=depleted"},
        {"oid": "1.3.6.1.4.1.3808.1.1.1.2.2.1.0",   "name": "upsBatteryCapacity",      "type": "integer", "description": "Battery %"},
        {"oid": "1.3.6.1.4.1.3808.1.1.1.2.2.3.0",   "name": "upsBatteryRunTimeRemaining","type":"integer","description": "Runtime (seconds)"},
        {"oid": "1.3.6.1.4.1.3808.1.1.1.2.2.4.0",   "name": "upsBatteryReplaceIndicator","type":"integer","description": "1=ok 2=needs-replacement"},
        {"oid": "1.3.6.1.4.1.3808.1.1.1.3.2.1.0",   "name": "upsInputLineVoltage",     "type": "integer", "description": "Input voltage (tenths of V)"},
        {"oid": "1.3.6.1.4.1.3808.1.1.1.4.2.1.0",   "name": "upsOutputVoltage",        "type": "integer"},
        {"oid": "1.3.6.1.4.1.3808.1.1.1.4.2.3.0",   "name": "upsOutputLoad",           "type": "integer", "description": "Load %"},
        {"oid": "1.3.6.1.4.1.3808.1.1.1.2.2.5.0",   "name": "upsBatteryTemperature",   "type": "integer"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 27. Cisco Meraki MX / MS / MR (limited SNMP)
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Cisco Meraki' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Cisco Meraki',
      'Cisco Meraki MX (security appliance), MS (switch), MR (access point). NOTE: Meraki SNMP is intentionally minimal — the Meraki Dashboard API is the rich data source. This template covers what SNMP does expose: device list, status, and basic interface counters. Enable SNMP per-network via the Dashboard first.',
      'Meraki', 'unknown',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",               "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                 "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",                 "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",            "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",            "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",           "type": "counter64"},
        {"oid": "1.3.6.1.4.1.29671.1.1.4.1.2",      "name": "devProductCode",          "type": "table",   "description": "Meraki device product code"},
        {"oid": "1.3.6.1.4.1.29671.1.1.4.1.3",      "name": "devSerial",               "type": "table",   "description": "Meraki device serial"},
        {"oid": "1.3.6.1.4.1.29671.1.1.4.1.4",      "name": "devMac",                  "type": "table"},
        {"oid": "1.3.6.1.4.1.29671.1.1.4.1.5",      "name": "devClientCount",          "type": "table",   "description": "Connected client count"},
        {"oid": "1.3.6.1.4.1.29671.1.1.4.1.6",      "name": "devStatus",               "type": "table",   "description": "1=online 2=offline 3=alerting"}
      ]'::jsonb, true);
  END IF;

  -- ========================================================================
  -- 28. Ruckus / CommScope Access Point
  -- ========================================================================
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Ruckus / CommScope AP' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in) VALUES (
      NULL, 'Ruckus / CommScope AP',
      'Ruckus (now CommScope) Unleashed and ZoneDirector-managed APs. Vendor enterprise OID 1.3.6.1.4.1.25053; this template covers the well-documented identity + interface + WLAN client count OIDs.',
      'CommScope', 'access_point',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",                "name": "sysDescr",                "type": "string"},
        {"oid": "1.3.6.1.2.1.1.3.0",                "name": "sysUpTime",               "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.1.5.0",                "name": "sysName",                 "type": "string"},
        {"oid": "1.3.6.1.2.1.2.2.1.2",              "name": "ifDescr",                 "type": "table"},
        {"oid": "1.3.6.1.2.1.2.2.1.8",              "name": "ifOperStatus",            "type": "table"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6",           "name": "ifHCInOctets",            "type": "counter64"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.10",          "name": "ifHCOutOctets",           "type": "counter64"},
        {"oid": "1.3.6.1.2.1.25.1.1.0",             "name": "hrSystemUptime",          "type": "timeticks"},
        {"oid": "1.3.6.1.2.1.25.2.2.0",             "name": "hrMemorySize",            "type": "integer"},
        {"oid": "1.3.6.1.2.1.25.3.3.1.2",           "name": "hrProcessorLoad",         "type": "table"},
        {"oid": "1.3.6.1.4.1.25053.1.2.1.1.1.15.0", "name": "ruckusZDSystemSerialNo",  "type": "string",  "description": "Ruckus ZD serial (when controller-managed)"}
      ]'::jsonb, true);
  END IF;

END $$;
