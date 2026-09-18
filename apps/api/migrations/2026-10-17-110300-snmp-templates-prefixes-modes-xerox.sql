-- SNMP template sysObjectID prefixes, acquisition modes, and the Xerox built-in.
-- Spec: docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md
--       §8 (template selection, Xerox alias), §7.1 (mode/cadence), §13 (data changes).
--
-- SYSTEM SCOPE IS ELECTED FIRST AND IT IS LOAD-BEARING. snmp_templates is
-- FORCE ROW LEVEL SECURITY; its INSERT/UPDATE policies
-- (2026-05-02-snmp-secret-hardening.sql) admit a built-in row only under
-- `breeze_current_scope() = 'system' AND org_id IS NULL`. Without this line the
-- UPDATEs below match ZERO rows silently (the RAISE NOTICE prints a truthful
-- looking 0) and the INSERT aborts with 42501. `is_local => true` scopes it to
-- autoMigrate's per-file transaction. Enforced by
-- apps/api/src/db/migrationRlsScope.test.ts.
--
-- Idempotent throughout: re-applying this file is a no-op. Every prefix below
-- is an IANA Private Enterprise Number verified against
-- https://www.iana.org/assignments/enterprise-numbers.txt (last updated
-- 2026-09-15); the registrant string is quoted on each line. Only ROOT arcs are
-- seeded — product sub-arcs are not IANA-assigned and are left to the
-- device_type tie-break in services/snmpTemplateSuggest.ts.

SELECT set_config('breeze.scope', 'system', true);

-- ---------------------------------------------------------------------------
-- 1. Column
-- ---------------------------------------------------------------------------
ALTER TABLE snmp_templates
  ADD COLUMN IF NOT EXISTS sys_object_id_prefixes text[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- 2. New built-in: Xerox Printer (spec D5 / §8)
--    The Generic Printer (RFC 3805) OID set, written literally so this row does
--    not inherit whatever state the Generic row is in, with mode/cadence baked
--    in. Scalars end in `.0` and are GETs; every Printer-MIB / HOST-RESOURCES
--    column is a WALK (a GET on a column OID returns noSuchObject — spec F3).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM snmp_templates WHERE name = 'Xerox Printer' AND is_built_in = true) THEN
    INSERT INTO snmp_templates (org_id, name, description, vendor, device_type, oids, is_built_in, sys_object_id_prefixes)
    VALUES (
      NULL, 'Xerox Printer',
      'Xerox VersaLink / AltaLink / WorkCentre / Phaser printers and MFPs. Uses the standards-based RFC 3805 Printer-MIB set (toner and ink levels, input trays, page counts, error states) plus HOST-RESOURCES-MIB status. Selected automatically for devices whose sysObjectID is under the Xerox enterprise arc 1.3.6.1.4.1.253.',
      'Xerox', 'printer',
      '[
        {"oid": "1.3.6.1.2.1.1.1.0",           "name": "sysDescr",                    "type": "string",   "mode": "get",  "description": "Printer model + firmware"},
        {"oid": "1.3.6.1.2.1.1.5.0",           "name": "sysName",                     "type": "string",   "mode": "get",  "description": "Configured device name"},
        {"oid": "1.3.6.1.2.1.1.6.0",           "name": "sysLocation",                 "type": "string",   "mode": "get",  "description": "Physical location"},
        {"oid": "1.3.6.1.2.1.25.3.2.1.5",      "name": "hrDeviceStatus",              "type": "table",    "mode": "walk", "description": "1=unknown 2=running 3=warning 4=testing 5=down"},
        {"oid": "1.3.6.1.2.1.25.3.5.1.1",      "name": "hrPrinterStatus",             "type": "table",    "mode": "walk", "description": "1=other 2=unknown 3=idle 4=printing 5=warmup"},
        {"oid": "1.3.6.1.2.1.25.3.5.1.2",      "name": "hrPrinterDetectedErrorState", "type": "table",    "mode": "walk", "description": "Bitmask of error conditions (paper jam, low toner, etc.)"},
        {"oid": "1.3.6.1.2.1.43.5.1.1.16",     "name": "prtGeneralPrinterName",       "type": "table",    "mode": "walk", "description": "Vendor-assigned printer name"},
        {"oid": "1.3.6.1.2.1.43.5.1.1.17",     "name": "prtGeneralSerialNumber",      "type": "table",    "mode": "walk", "description": "Serial number"},
        {"oid": "1.3.6.1.2.1.43.8.2.1.10",     "name": "prtInputCurrentLevel",        "type": "table",    "mode": "walk", "description": "Sheets remaining per input tray"},
        {"oid": "1.3.6.1.2.1.43.8.2.1.13",     "name": "prtInputName",                "type": "table",    "mode": "walk", "cadence": "slow", "description": "Input tray name"},
        {"oid": "1.3.6.1.2.1.43.10.2.1.4",     "name": "prtMarkerLifeCount",          "type": "table",    "mode": "walk", "description": "Lifetime page count"},
        {"oid": "1.3.6.1.2.1.43.10.2.1.5",     "name": "prtMarkerPowerOnCount",       "type": "table",    "mode": "walk", "description": "Pages since power-on"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.5",     "name": "prtMarkerSuppliesType",       "type": "table",    "mode": "walk", "cadence": "slow", "description": "Toner/ink type per supply"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.6",     "name": "prtMarkerSuppliesDescription","type": "table",    "mode": "walk", "cadence": "slow", "description": "Vendor description (e.g., Cyan Toner)"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.8",     "name": "prtMarkerSuppliesMaxCapacity","type": "table",    "mode": "walk", "description": "Max capacity"},
        {"oid": "1.3.6.1.2.1.43.11.1.1.9",     "name": "prtMarkerSuppliesLevel",      "type": "table",    "mode": "walk", "description": "Current level (negative = unknown)"},
        {"oid": "1.3.6.1.2.1.43.12.1.1.4",     "name": "prtMarkerColorantValue",      "type": "table",    "mode": "walk", "cadence": "slow", "description": "Color name per supply"}
      ]'::jsonb,
      true,
      ARRAY['1.3.6.1.4.1.253']::text[]   -- Xerox
    );
    RAISE NOTICE 'inserted built-in SNMP template "Xerox Printer"';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Seed sysObjectID prefixes on the existing built-ins, by name.
--    `sys_object_id_prefixes = '{}'` in the WHERE makes this idempotent AND
--    preserves an operator's non-empty prefix override.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  WITH seed(template_name, prefixes) AS (
    VALUES
      ('Cisco IOS Switch'::text,             ARRAY['1.3.6.1.4.1.9']::text[]),                                    -- ciscoSystems
      ('Cisco IOS Router',                   ARRAY['1.3.6.1.4.1.9']),                                            -- ciscoSystems
      ('Cisco ASA Firewall',                 ARRAY['1.3.6.1.4.1.9']),                                            -- ciscoSystems
      ('Cisco Meraki',                       ARRAY['1.3.6.1.4.1.29671']),                                        -- Meraki Networks, Inc.
      ('Fortinet FortiGate',                 ARRAY['1.3.6.1.4.1.12356']),                                        -- Fortinet, Inc.
      ('SonicWall Firewall',                 ARRAY['1.3.6.1.4.1.8741']),                                         -- SonicWALL, Inc.
      ('MikroTik RouterOS',                  ARRAY['1.3.6.1.4.1.14988']),                                        -- MikroTik
      ('Aruba / HPE ProCurve Switch',        ARRAY['1.3.6.1.4.1.11','1.3.6.1.4.1.14823','1.3.6.1.4.1.47196']),   -- Hewlett-Packard / Aruba, a HPE company / Hewlett Packard Enterprise
      ('Synology DSM (NAS)',                 ARRAY['1.3.6.1.4.1.6574']),                                         -- Synology Inc.
      ('QNAP QTS (NAS)',                     ARRAY['1.3.6.1.4.1.24681','1.3.6.1.4.1.55062']),                    -- QNAP SYSTEMS, INC / QNAP Systems, Inc.
      ('APC UPS (PowerNet)',                 ARRAY['1.3.6.1.4.1.318']),                                          -- American Power Conversion Corp.
      ('Linux net-snmpd',                    ARRAY['1.3.6.1.4.1.8072']),                                         -- net-snmp
      ('pfSense / OPNsense',                 ARRAY['1.3.6.1.4.1.8072','1.3.6.1.4.1.53869']),                     -- net-snmp (pfSense reports it) / OPNsense
      ('VMware ESXi Host',                   ARRAY['1.3.6.1.4.1.6876']),                                         -- VMware Inc.
      ('Juniper JUNOS',                      ARRAY['1.3.6.1.4.1.2636']),                                         -- Juniper Networks, Inc.
      ('Dell Networking PowerSwitch',        ARRAY['1.3.6.1.4.1.674']),                                          -- Dell Inc.
      ('Dell PowerEdge (iDRAC)',             ARRAY['1.3.6.1.4.1.674']),                                          -- Dell Inc.
      ('HPE ProLiant Server (iLO)',          ARRAY['1.3.6.1.4.1.232','1.3.6.1.4.1.47196']),                      -- Compaq (the ProLiant/iLO arc) / Hewlett Packard Enterprise
      ('Lenovo ThinkSystem (XCC)',           ARRAY['1.3.6.1.4.1.19046']),                                        -- Lenovo Enterprise Business Group
      ('Netgear ProSAFE Switch',             ARRAY['1.3.6.1.4.1.4526']),                                         -- Netgear
      ('TP-Link Omada Switch',               ARRAY['1.3.6.1.4.1.11863']),                                        -- TP-Link Systems Inc.
      ('Brother Printer',                    ARRAY['1.3.6.1.4.1.2435']),                                         -- Brother Industries, Ltd.
      ('Lexmark Printer',                    ARRAY['1.3.6.1.4.1.641']),                                          -- Lexmark International
      ('Eaton UPS',                          ARRAY['1.3.6.1.4.1.534']),                                          -- Eaton Corporation
      ('CyberPower UPS',                     ARRAY['1.3.6.1.4.1.3808','1.3.6.1.4.1.15446']),                     -- Cyber Power System Inc. / CyberPower Systems, Inc.
      ('Ruckus / CommScope AP',              ARRAY['1.3.6.1.4.1.25053']),                                        -- Ruckus Wireless, Inc.
      ('Ubiquiti UniFi Switch',              ARRAY['1.3.6.1.4.1.41112']),                                        -- Ubiquiti Networks, Inc.
      ('Ubiquiti UniFi Access Point',        ARRAY['1.3.6.1.4.1.41112']),                                        -- Ubiquiti Networks, Inc.
      ('Ubiquiti UniFi Gateway',             ARRAY['1.3.6.1.4.1.41112'])                                         -- Ubiquiti Networks, Inc.
      -- Deliberately NOT seeded (they are the by-device-type fallbacks, spec §8):
      --   'Generic Printer (RFC 3805)', 'Generic UPS (RFC 1628)'.
  )
  UPDATE snmp_templates t
     SET sys_object_id_prefixes = seed.prefixes
    FROM seed
   WHERE t.name = seed.template_name
     AND t.is_built_in = true
     AND t.sys_object_id_prefixes = '{}';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 29 THEN RAISE WARNING 'expected 29 seeded prefix rows, got %', n; END IF;
  RAISE NOTICE 'seeded sysObjectID prefixes on % built-in SNMP templates', n;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Acquisition mode on built-in PRINTER templates (spec §8).
--    `.0` suffix => scalar => get; everything else is a table column => walk.
--    The entry's `type` cannot decide this (ifHCInOctets is counter64 AND a
--    column) — spec §7.1. Existing `mode` keys are preserved.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE snmp_templates t
     SET oids = COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN e.entry ? 'mode' THEN e.entry
                         ELSE e.entry || jsonb_build_object(
                                'mode',
                                CASE WHEN e.entry->>'oid' LIKE '%.0' THEN 'get' ELSE 'walk' END)
                    END
                    ORDER BY e.ord)
             FROM jsonb_array_elements(t.oids) WITH ORDINALITY AS e(entry, ord)
         ), '[]'::jsonb)
   WHERE t.is_built_in = true
     AND t.device_type = 'printer'
     AND jsonb_typeof(t.oids) = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.oids) AS x(entry)
                  WHERE NOT (x.entry ? 'mode'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'set acquisition mode on % built-in printer templates', n;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Slow cadence on the static descriptor OIDs named in spec §7.1, across all
--    built-ins (ifDescr/ifName/ifSpeed live in the switch templates). These
--    change ~never, so W02 ships them on every 12th dispatch instead of every
--    poll. Existing `cadence` keys are preserved.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
  slow_names text[] := ARRAY[
    'ifDescr', 'ifName', 'ifSpeed',
    'prtInputName', 'prtMarkerSuppliesDescription', 'prtMarkerSuppliesType',
    'prtMarkerColorantValue'
  ];
BEGIN
  UPDATE snmp_templates t
     SET oids = COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN e.entry ? 'cadence' THEN e.entry
                         WHEN e.entry->>'name' = ANY (slow_names)
                           THEN e.entry || '{"cadence":"slow"}'::jsonb
                         ELSE e.entry
                    END
                    ORDER BY e.ord)
             FROM jsonb_array_elements(t.oids) WITH ORDINALITY AS e(entry, ord)
         ), '[]'::jsonb)
   WHERE t.is_built_in = true
     AND jsonb_typeof(t.oids) = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.oids) AS x(entry)
                  WHERE NOT (x.entry ? 'cadence')
                    AND x.entry->>'name' = ANY (slow_names));
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'marked slow-cadence OID entries on % built-in SNMP templates', n;
END $$;
