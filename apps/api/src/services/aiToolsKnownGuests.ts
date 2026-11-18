/**
 * `manage_known_guests` (full-control W09, #6779): the AI twin of
 * routes/networkKnownGuests.ts — the partner-wide list of MAC addresses that
 * discovery must not report as unknown devices.
 *
 * Partner-wide state: the whole router is gated on `canManagePartnerWidePolicies`
 * (full partner scope), the permission floor is `organizations:read|write`, and the
 * write routes carry `requireMfa()` (QW4). Tier 1 list; add / delete tier 2 (a
 * tenant-internal row, reversible). An agent / helper / MCP-key context has no
 * `partnerOrgAccess` and fails closed, so the tool is `AGENT_HUMAN_ONLY`.
 * Rows are keyed by the caller's own `partnerId`: another partner's id is "not found".
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { networkKnownGuests } from '../db/schema';
import type { AiTool } from './aiTools';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { KNOWN_GUEST_ACTIONS } from './aiToolSchemasNetworkMonitoring';
import { parseData } from './aiToolsTicketOpsShared';
import { bounded, defined, json, jsonError, mfaDenied, requireFields, thrown } from './aiToolsNetworkMonitoringShared';

type Action = (typeof KNOWN_GUEST_ACTIONS)[number];

const LIST_CAP = 500;

// Same rule as the route: colon-separated hex pairs, case-insensitive.
const macRegex = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;
const addGuestSchema = z.object({
  macAddress: z.string().regex(macRegex, 'Invalid MAC address format (expected XX:XX:XX:XX:XX:XX)'),
  label: z.string().min(1).max(255),
  notes: z.string().optional(),
});

export function registerKnownGuestTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_known_guests', {
    tier: 1,
    domain: 'network',
    searchHint: 'known guests: MAC addresses discovery should not flag as unknown devices (visitor phones, kiosks)',
    deviceArgs: [],
    definition: {
      name: 'manage_known_guests',
      description:
        'The partner-wide list of known guest MAC addresses that discovery does not flag as unknown. Actions: list, add (macAddress,label), delete (guestId). Applies to every organization of the partner.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...KNOWN_GUEST_ACTIONS], description: 'The action to perform' },
          guestId: { type: 'string', description: 'delete: known guest UUID' },
          macAddress: { type: 'string', description: 'add: MAC as XX:XX:XX:XX:XX:XX' },
          label: { type: 'string', description: 'add: what this device is (max 255)' },
          notes: { type: 'string', description: 'add: optional free-text note' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!KNOWN_GUEST_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);

      // The router-level gate of routes/networkKnownGuests.ts, applied to reads too.
      if (!canManagePartnerWidePolicies(auth)) {
        return jsonError('Full partner scope is required to manage the shared known-guest list', 'ACCESS_DENIED');
      }
      if (!auth.partnerId) return jsonError('Partner context required', 'ACCESS_DENIED');
      const partnerId = auth.partnerId;
      if (action !== 'list') {
        const mfa = mfaDenied(auth);
        if (mfa) return mfa;
      }

      try {
        switch (action) {
          case 'list': {
            const rows = await db
              .select({
                id: networkKnownGuests.id, macAddress: networkKnownGuests.macAddress, label: networkKnownGuests.label,
                notes: networkKnownGuests.notes, createdAt: networkKnownGuests.createdAt,
              })
              .from(networkKnownGuests)
              .where(eq(networkKnownGuests.partnerId, partnerId))
              .orderBy(networkKnownGuests.createdAt)
              .limit(LIST_CAP + 1);
            return bounded({ guests: rows.slice(0, LIST_CAP), truncated: rows.length > LIST_CAP });
          }
          case 'add': {
            const missing = requireFields(input, ['macAddress', 'label'], action);
            if (missing) return missing;
            const parsed = parseData(addGuestSchema, defined({ macAddress: input.macAddress, label: input.label, notes: input.notes }));
            if ('error' in parsed) return parsed.error;
            const body = parsed.value;
            // ON CONFLICT DO NOTHING (not catch-and-map): a raised unique violation would poison the per-call transaction.
            const [guest] = await db
              .insert(networkKnownGuests)
              .values({
                partnerId,
                macAddress: body.macAddress.toLowerCase(),
                label: body.label,
                notes: body.notes ?? null,
                addedBy: auth.user?.id ?? null,
              })
              .onConflictDoNothing()
              .returning({
                id: networkKnownGuests.id, macAddress: networkKnownGuests.macAddress, label: networkKnownGuests.label,
                notes: networkKnownGuests.notes, createdAt: networkKnownGuests.createdAt,
              });
            if (!guest) return jsonError('This MAC address is already in your known guests list', 'ALREADY_EXISTS');
            return json({ added: true, guest });
          }
          case 'delete': {
            const missing = requireFields(input, ['guestId'], action);
            if (missing) return missing;
            const deleted = await db
              .delete(networkKnownGuests)
              .where(and(eq(networkKnownGuests.id, String(input.guestId)), eq(networkKnownGuests.partnerId, partnerId)))
              .returning({
                id: networkKnownGuests.id, macAddress: networkKnownGuests.macAddress, label: networkKnownGuests.label,
              });
            // Another partner's id is the same answer as a missing one.
            if (deleted.length === 0) return jsonError('Known guest not found', 'NOT_FOUND');
            return json({ deleted: true, guest: deleted[0] });
          }
        }
      } catch (error) {
        return thrown('manage_known_guests', error);
      }
    },
  });
}
