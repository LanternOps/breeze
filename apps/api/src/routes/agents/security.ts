import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, securityStatus } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { recordAgentIngestSubmission } from '../metrics';
import { securityStatusIngestSchema, managementPostureIngestSchema } from './schemas';
import { upsertSecurityStatusForDevice } from './helpers';
import { requireAgentRole } from '../../middleware/requireAgentRole';

type Change = { field: string; before: unknown; after: unknown };

/** Order-insensitive, key-sorted JSON for comparing posture fragments. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).sort().join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * #4340 — which parts of a management posture genuinely changed. The agent
 * re-scans every 15 minutes and stamps `collectedAt` / `scanDurationMs` /
 * collection `errors` on each scan, so those are ignored; detections are
 * compared order-insensitively per category. Returns `identity` and/or
 * `categories.<name>`; a device with no stored posture yields every present
 * part.
 */
export function managementPostureChanges(before: unknown, after: unknown): string[] {
  const prev = (before && typeof before === 'object' ? before : {}) as {
    identity?: unknown;
    categories?: Record<string, unknown>;
  };
  const next = (after && typeof after === 'object' ? after : {}) as typeof prev;
  const changed: string[] = [];
  if (canonicalJson(prev.identity) !== canonicalJson(next.identity)) {
    changed.push('identity');
  }
  const categoryNames = new Set([
    ...Object.keys(prev.categories ?? {}),
    ...Object.keys(next.categories ?? {}),
  ]);
  for (const name of [...categoryNames].sort()) {
    // An absent category and an empty one both mean "nothing detected".
    const a = prev.categories?.[name] ?? [];
    const b = next.categories?.[name] ?? [];
    if (canonicalJson(a) !== canonicalJson(b)) changed.push(`categories.${name}`);
  }
  return changed;
}

export const agentSecurityRoutes = new Hono();
// Security + management-posture ingest is the main agent's job; reject
// watchdog-role tokens so a weaker credential can't falsify operator-facing
// security/compliance posture for the device (F3).
agentSecurityRoutes.use('*', requireAgentRole);

agentSecurityRoutes.put('/:id/security/status', zValidator('json', securityStatusIngestSchema), async (c) => {
  const agentId = c.req.param('id');
  const payload = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  // #4340 — the security_status row is overwritten in place, so the audit is
  // the only history of provider / threat-count transitions. But a per-submit
  // audit was ~11% of audit_logs; record it only when one of them CHANGED
  // (including the first report for a device). Read-then-write, so two
  // concurrent submits for one device can at worst double- or under-report a
  // single transition; the agent serializes these submits in practice.
  const [previous] = await db
    .select({ provider: securityStatus.provider, threatCount: securityStatus.threatCount })
    .from(securityStatus)
    .where(eq(securityStatus.deviceId, device.id))
    .limit(1);

  let written: Awaited<ReturnType<typeof upsertSecurityStatusForDevice>>;
  try {
    written = await upsertSecurityStatusForDevice(device.id, device.orgId, payload);
  } catch (err) {
    recordAgentIngestSubmission('security_status', 'failed');
    throw err;
  }
  recordAgentIngestSubmission('security_status', 'success');

  const changes: Change[] = [];
  if ((previous?.provider ?? null) !== written.provider) {
    changes.push({ field: 'provider', before: previous?.provider ?? null, after: written.provider });
  }
  if ((previous?.threatCount ?? null) !== written.threatCount) {
    changes.push({ field: 'threatCount', before: previous?.threatCount ?? null, after: written.threatCount });
  }
  if (changes.length > 0) {
    writeAuditEvent(c, {
      orgId: agent?.orgId ?? device.orgId,
      actorType: 'agent',
      actorId: agent?.agentId ?? agentId,
      action: 'agent.security_status.submit',
      resourceType: 'device',
      resourceId: device.id,
      details: {
        provider: written.provider,
        threatCount: written.threatCount,
        changes,
      },
    });
  }
  return c.json({ success: true });
});

agentSecurityRoutes.put('/:id/management/posture', zValidator('json', managementPostureIngestSchema), async (c) => {
  const agentId = c.req.param('id');
  const payload = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId, managementPosture: devices.managementPosture })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  try {
    await db
      .update(devices)
      .set({
        managementPosture: payload,
        updatedAt: new Date(),
      })
      .where(eq(devices.id, device.id));
  } catch (err) {
    console.error('[agents] management posture DB update failed:', { agentId, deviceId: device.id, error: err });
    recordAgentIngestSubmission('management_posture', 'failed');
    return c.json({ error: 'Failed to save management posture' }, 500);
  }
  recordAgentIngestSubmission('management_posture', 'success');

  // #4340 — devices.management_posture is overwritten on every 15-minute scan,
  // so audit only a scan that changed what is detected (or the identity join).
  const changed = managementPostureChanges(device.managementPosture, payload);
  if (changed.length > 0) {
    try {
      writeAuditEvent(c, {
        orgId: agent?.orgId ?? device.orgId,
        actorType: 'agent',
        actorId: agent?.agentId ?? agentId,
        action: 'agent.management_posture.submit',
        resourceType: 'device',
        resourceId: device.id,
        details: { changed },
      });
    } catch (auditErr) {
      console.error('[agents] audit event write failed for posture submit:', auditErr);
    }
  }

  return c.json({ success: true });
});
