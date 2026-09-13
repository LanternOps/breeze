import { sql } from 'drizzle-orm';
import { db } from '../../db';

export interface DeviceLinkReconciliation {
  linkedBySerial: number;
  linkedByHostname: number;
  /** Normalised serials present on both sides but not 1:1 — deliberately skipped. */
  ambiguous: number;
}

function count(result: unknown, key: string): number {
  const list = (result as { rows?: unknown[] }).rows ?? result;
  const row = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
  return Number(row?.[key] ?? 0) || 0;
}

/**
 * Spec §5.6. Two set-based statements over ALL of the org's non-stale Intune
 * rows — not only the rows this run changed — so a Breeze agent enrolled after
 * the last Intune snapshot links on the next run without waiting for the Graph
 * row to change.
 *
 * Matching is 1:1 only, on BOTH sides. A serial duplicated across two Breeze
 * devices (chassis swaps, imaging templates that leave "To Be Filled By
 * O.E.M.", VMs) or across two Intune rows is skipped and counted, never
 * guessed: a wrong link puts one customer machine's Intune posture on another
 * machine's device page. Decommissioned and ephemeral (Quick Support) Breeze
 * devices are not candidates — a re-enrolled machine would otherwise be
 * "ambiguous" with its own retired record forever.
 *
 * The serial predicate is "unlinked OR linked to something that no longer
 * matches" (`IS DISTINCT FROM`), which is what makes a re-imaged machine re-link
 * instead of keeping a dead pointer; any OTHER Intune row still pointing at a
 * device the serial pass just claimed is released in the same statement, so a
 * device page never shows two Intune records. Rows whose device was deleted are
 * already NULLed by the composite FK's column-specific ON DELETE SET NULL.
 *
 * MUST run inside a system DB context (the post-commit hook opens one): it is
 * a cross-org worker, so every CTE filters `org_id` explicitly — RLS is not
 * doing that work here. Only `breeze_device_id` is written: a link is
 * Breeze-side state, and bumping `last_changed_at` would make change alerts
 * fire on every agent enrolment.
 */
export async function reconcileDeviceLinks(orgId: string): Promise<DeviceLinkReconciliation> {
  const serialRows = await db.execute(sql`
    with intune as (
      select i.id, lower(btrim(i.serial_number)) as key
      from m365_intune_devices i
      where i.org_id = ${orgId}::uuid
        and i.is_stale = false
        and i.serial_number is not null
        and btrim(i.serial_number) <> ''
    ),
    breeze as (
      select d.id as device_id, lower(btrim(h.serial_number)) as key
      from device_hardware h
      join devices d on d.id = h.device_id and d.org_id = h.org_id
      where h.org_id = ${orgId}::uuid
        and d.is_ephemeral = false
        and d.status <> 'decommissioned'
        and h.serial_number is not null
        and btrim(h.serial_number) <> ''
    ),
    intune_counts as (select key, count(*) as n from intune group by key),
    breeze_counts as (select key, count(*) as n from breeze group by key),
    matched as (
      select i.id, b.device_id
      from intune i
      join intune_counts ic on ic.key = i.key and ic.n = 1
      join breeze b         on b.key  = i.key
      join breeze_counts bc on bc.key = b.key and bc.n = 1
    ),
    ambiguous as (
      select ic.key
      from intune_counts ic
      join breeze_counts bc on bc.key = ic.key
      where ic.n > 1 or bc.n > 1
    ),
    released as (
      update m365_intune_devices t
      set breeze_device_id = null
      where t.org_id = ${orgId}::uuid
        and t.breeze_device_id in (select device_id from matched)
        and t.id not in (select id from matched)
      returning 1
    ),
    linked as (
      update m365_intune_devices t
      set breeze_device_id = m.device_id
      from matched m
      where t.id = m.id
        and t.org_id = ${orgId}::uuid
        and t.breeze_device_id is distinct from m.device_id
      returning 1
    )
    select
      (select count(*) from linked)::int    as linked,
      (select count(*) from released)::int  as released,
      (select count(*) from ambiguous)::int as ambiguous
  `);

  const hostnameRows = await db.execute(sql`
    with intune as (
      select i.id, lower(btrim(i.device_name)) as key
      from m365_intune_devices i
      where i.org_id = ${orgId}::uuid
        and i.is_stale = false
        and i.breeze_device_id is null
        and i.device_name is not null
        and btrim(i.device_name) <> ''
    ),
    breeze as (
      select d.id as device_id, lower(btrim(d.hostname)) as key
      from devices d
      where d.org_id = ${orgId}::uuid
        and d.is_ephemeral = false
        and d.status <> 'decommissioned'
        and btrim(d.hostname) <> ''
        and not exists (
          select 1 from m365_intune_devices x
          where x.org_id = ${orgId}::uuid and x.breeze_device_id = d.id
        )
    ),
    intune_counts as (select key, count(*) as n from intune group by key),
    breeze_counts as (select key, count(*) as n from breeze group by key),
    matched as (
      select i.id, b.device_id
      from intune i
      join intune_counts ic on ic.key = i.key and ic.n = 1
      join breeze b         on b.key  = i.key
      join breeze_counts bc on bc.key = b.key and bc.n = 1
    ),
    linked as (
      update m365_intune_devices t
      set breeze_device_id = m.device_id
      from matched m
      where t.id = m.id
        and t.org_id = ${orgId}::uuid
        and t.breeze_device_id is null
      returning 1
    )
    select (select count(*) from linked)::int as linked
  `);

  return {
    linkedBySerial: count(serialRows, 'linked'),
    linkedByHostname: count(hostnameRows, 'linked'),
    ambiguous: count(serialRows, 'ambiguous'),
  };
}
