/**
 * §5.8 org-move parity. Org move (`moveDeviceOrgInTransaction`) already drops
 * several kinds of device-bound authority; the install boundary starts from
 * that set (§5). Every device-bound write and helper call of the move engine
 * is listed here as either
 *  - `boundary`: the boundary has a counterpart, in the named handler, for the
 *    named table(s); or
 *  - `moveOnly`: it exists because the device changes TENANT (a cross-tenant
 *    pointer, an org re-stamp, a lock or guard of the move), which a reattach
 *    does not do — the device keeps its org, site and id.
 *
 * `orgMoveParity.test.ts` scans the move engine (`__tests__/helpers/orgMoveParityScan.ts`)
 * and fails when it writes or calls something not listed here, when an entry
 * here no longer occurs in it, or when a `boundary` entry names a table its
 * handler does not list. A new invalidation added to org move therefore has
 * to be classified for the reattach too.
 */
import type { BoundaryHandlerId } from './types';

export type OrgMoveParityEntry =
  | { boundary: BoundaryHandlerId; tables: readonly string[] }
  | { moveOnly: string };

const TENANT_POINTER = 'a cross-tenant pointer once the device leaves the org; a reattach keeps the org';
const TICKET_CHAIN = 'tickets follow the device to the new org; a reattach keeps the org, so tickets stay put';
const ALERT_CHAIN = 'alert-axis rows follow the device to the new org; a reattach keeps the org';

export const ORG_MOVE_PARITY: Readonly<Record<string, OrgMoveParityEntry>> = {
  // Invalidations the boundary repeats.
  'call:expireUnactuatedElevationRequests': { boundary: 'pam', tables: ['elevation_requests'] },
  'call:revokeWorkstationGrantsForMove': { boundary: 'grants', tables: ['caller_verifications'] },
  'call:revokeDiagnosticGrantsForMove': { boundary: 'grants', tables: ['diagnostic_access_grants'] },
  'call:propagateCancelledDeviceCommands': { boundary: 'commands', tables: ['device_commands'] },
  'call:terminalPayloadErasureSet': { boundary: 'commands', tables: ['device_commands'] },
  'table:device_commands': { boundary: 'commands', tables: ['device_commands'] },
  'table:endpoint_conversations': { boundary: 'sessions', tables: ['endpoint_conversations'] },
  'table:action_intents': { boundary: 'work_in_flight', tables: ['action_intents'] },
  'table:ai_operator_tasks': { boundary: 'work_in_flight', tables: ['ai_operator_tasks'] },
  'table:ai_operator_task_targets': { boundary: 'work_in_flight', tables: ['ai_operator_task_targets'] },

  // The move's own locks, guards and step-up.
  'call:lockOrgTicketLinks': { moveOnly: 'ticket-link lock taken for the org change' },
  'call:lockActorAssurance': { moveOnly: 'step-up admission of the mover (the reattach consumes its own at request, §8)' },
  'call:consumeStepUpGrant': { moveOnly: 'step-up admission of the mover (the reattach consumes its own at request, §8)' },
  'call:readOrgStampingDefaultsMany': { moveOnly: 'org currency pair locked for the move' },
  'call:resolvePamEpochTransfer': { moveOnly: 'PAM ownership epoch: advances only on an org change' },
  'call:armOwnershipChange': { moveOnly: 'PAM ownership epoch: advances only on an org change' },
  'call:assertPamDeviceOrgMoveAllowed': { moveOnly: 'PAM refusal of an org change' },
  'call:assertDeviceTicketsNotPinnedToDeliverable': { moveOnly: TICKET_CHAIN },
  'call:checkPoolMembershipTransition': { moveOnly: 'holding-area membership rule of an org change' },
  'call:assertNoPendingApprovalRequest': { moveOnly: TICKET_CHAIN },
  'call:assertNoHourBlockDrawnTime': { moveOnly: TICKET_CHAIN },
  'call:assertTicketMoveCurrencyCompatible': { moveOnly: TICKET_CHAIN },
  'call:revalidateTicketAssignee': { moveOnly: TICKET_CHAIN },
  'call:removedTicketLinksFromRows': { moveOnly: TICKET_CHAIN },
  'call:dissolveLinkGroupIfBelowMinimum': { moveOnly: 'link groups are per org; a reattach keeps the org and the group' },

  // The org flip and the re-stamps that follow it.
  'table:devices': { moveOnly: 'the org/site flip (the boundary advances the incarnation instead)' },
  'call:getDeviceOrgDenormalizedTables': { moveOnly: 'org_id re-stamp of device children' },
  'call:getDeviceOrgMoveDeleteTables': { moveOnly: 'derived rows that point at source-org rows' },
  'call:rewriteDeviceSiteDenormalizedTables': { moveOnly: 'site_id re-stamp of device children' },
  'sqlfn:breeze_rehome_device_custom_field_values': { moveOnly: 'custom-field values re-pointed to the target org (§5.1: they survive a reattach)' },
  'table:device_group_memberships': { moveOnly: 'groups are per org; membership survives a reattach (§5.1)' },

  // Cross-tenant pointers severed because the device leaves the org.
  'table:manual_assets': { moveOnly: TENANT_POINTER },
  'table:m365_intune_devices': { moveOnly: TENANT_POINTER },
  'table:backup_provider_devices': { moveOnly: TENANT_POINTER },
  'table:edr_endpoints': { moveOnly: TENANT_POINTER },
  'table:edr_detections': { moveOnly: TENANT_POINTER },
  'table:edr_actions': { moveOnly: TENANT_POINTER },
  'table:discovery_profiles': { moveOnly: TENANT_POINTER },
  'table:endpoint_message_deliveries': {
    moveOnly: 'the move severs the delivery’s pointer to a source-org message; the boundary supersedes live deliveries in its sessions handler for its own reason',
  },
  'table:ai_agent_runs': { moveOnly: TENANT_POINTER },
  'table:script_executions': { moveOnly: 'AI provenance pointers across tenants; the boundary settles in-flight executions through their commands' },
  'table:invoice_line_devices': { moveOnly: TENANT_POINTER },
  'table:metric_anomaly_incidents': { moveOnly: TENANT_POINTER },
  'table:ticket_comments': { moveOnly: TENANT_POINTER },
  'table:device_function_assessments': { moveOnly: TENANT_POINTER },
  'table:device_vulnerabilities': { moveOnly: TENANT_POINTER },

  // The ticket chain (services/ticketOrgMoveLockOrder.ts).
  'table:tickets': { moveOnly: TICKET_CHAIN },
  'table:time_entries': { moveOnly: TICKET_CHAIN },
  'table:ticket_parts': { moveOnly: TICKET_CHAIN },
  'table:ticket_alert_links': { moveOnly: TICKET_CHAIN },
  'table:ticket_outbox': { moveOnly: TICKET_CHAIN },
  'table:ticket_attachments': { moveOnly: TICKET_CHAIN },
  'table:ticket_email_links': { moveOnly: TICKET_CHAIN },
  'table:ticket_checklist_items': { moveOnly: TICKET_CHAIN },
  'table:ticket_external_refs': { moveOnly: TICKET_CHAIN },
  'table:partner_api_idempotency_keys': { moveOnly: TICKET_CHAIN },
  'table:ticket_approval_requests': { moveOnly: TICKET_CHAIN },
  'table:ticket_links': { moveOnly: TICKET_CHAIN },

  // The alert axis.
  'table:alert_correlation_groups': { moveOnly: ALERT_CHAIN },
  'table:alert_correlation_members': { moveOnly: ALERT_CHAIN },
  'table:ai_alert_verdicts': { moveOnly: ALERT_CHAIN },
};
