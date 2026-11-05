/**
 * `manage_report_recipients` (full-control W18 PR B, #6789): the contact
 * recipients of a scheduled report, the AI twin of `GET/POST/DELETE
 * /reports/:id/recipients` and `POST /reports/:id/recipients/convert` over the
 * same exported operations (routes/reports/recipients.ts, Decision 8).
 *
 * Classes (aiGuardrails.ts, W18 plan class review):
 *  - `list` is a tier-1 read.
 *  - `add`, `remove` and `convert` are supervised: a recipient on an org-owned
 *    definition is a live delivery (reportScheduleWorker.ts mails the report to
 *    it on schedule), so report data leaves Breeze.
 *  - `add` and `convert` always need `reports:export` + MFA (Decision 5). Stricter
 *    than REST: REST needs export + MFA only for a series child's add, and convert
 *    carries MFA there but not export. `convert` accepts only an
 *    address already in the report's `config.emailRecipients`, so it moves an
 *    existing delivery and never adds one. `remove` keeps the route's conditional
 *    gate: removing a series exclusion restores a delivery and needs export + MFA.
 *
 * `add` and `convert` refuse partner-owned, system-managed and partner-only-
 * delivery definitions with the route's code; `remove` refuses only partner-owned
 * ones, as the route does (removing a stray contact is harmless). Agent-human-only (`AGENT_HUMAN_ONLY_TOOLS`);
 * a device-bound session cannot read and a site-restricted one cannot write.
 */
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import {
  addReportRecipient,
  convertReportRecipient,
  listReportRecipients,
  removeReportRecipient,
  type RecipientOutcome,
} from '../routes/reports/recipients';
import { contactCreateAuditEvent } from './contacts/audit';
import { aiCallerPermissions } from './aiToolCallerPermissions';
import { mfaGatedToolError } from './aiToolMfaGate';
import { REPORT_RECIPIENT_ACTIONS, orgAdminWriteToolSchemas } from './aiToolSchemasOrgAdminWrites';
import { auditToolWrite, bounded, deviceBoundDenied, json, jsonError, orgWideWriteDenied, thrown } from './aiToolsSecurityPolicyShared';
import { agentRefusal, isAgentPrincipal } from './aiToolsTicketOpsShared';
import { capped, orgAdminInputSchema, parseInput } from './aiToolsOrgAdminShared';

type Action = (typeof REPORT_RECIPIENT_ACTIONS)[number];

const TOOL = 'manage_report_recipients';
const WHAT = "A report's recipients";
const LIST_MAX = 200;

/** Which optional fields each action takes; any other present field is refused rather than ignored. */
const ACTION_FIELDS: Readonly<Record<Action, { required: readonly string[]; optional: readonly string[] }>> = {
  list: { required: [], optional: [] },
  add: { required: ['contactId'], optional: ['mode'] },
  remove: { required: ['contactId'], optional: [] },
  convert: { required: ['email'], optional: ['name'] },
};
const ALL_FIELDS = ['contactId', 'mode', 'email', 'name'] as const;

/** The route's refusal as a tool error, keeping its own code where it has one (`partner_owned_report`, ...). */
function refusal(out: Extract<RecipientOutcome<unknown>, { ok: false }>): string {
  const error = typeof out.body.error === 'string' ? out.body.error : 'Request refused';
  const message = typeof out.body.message === 'string' ? out.body.message : error;
  if (out.status === 404) return jsonError(`${error} (or access denied)`, 'NOT_FOUND');
  if (out.status === 403) return jsonError(error, 'EXPORT_AND_MFA_REQUIRED');
  return jsonError(message, /^[a-z_]+$/.test(error) ? error : 'VALIDATION_ERROR');
}

export function registerReportRecipientsTool(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'admin',
    searchHint: 'who receives a scheduled report by email: add or remove a contact recipient, move a legacy email address onto a contact',
    deviceArgs: [],
    definition: {
      name: TOOL,
      description:
        "Contact recipients of a scheduled report. list; add (contactId; mode 'remove' excludes on a series report); remove (contactId); convert (email already in the report's email list). Writes need approval; add and convert send report data out by email and need export permission.",
      input_schema: orgAdminInputSchema(orgAdminWriteToolSchemas.manage_report_recipients),
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!REPORT_RECIPIENT_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`, 'VALIDATION_ERROR');
      if (isAgentPrincipal(auth)) return agentRefusal(action);
      const denied = deviceBoundDenied(auth, WHAT)
        ?? (action !== 'list' ? orgWideWriteDenied(auth, WHAT) : null)
        ?? mfaGatedToolError(TOOL, action, auth);
      if (denied) return denied;

      const parsed = parseInput(orgAdminWriteToolSchemas.manage_report_recipients, input);
      if (!parsed.ok) return parsed.error;
      const fields = ACTION_FIELDS[action];
      for (const key of ALL_FIELDS) {
        const present = parsed.value[key] !== undefined;
        if (fields.required.includes(key) && !present) return jsonError(`${key} is required for ${action}`, 'VALIDATION_ERROR');
        if (present && !fields.required.includes(key) && !fields.optional.includes(key)) {
          return jsonError(`${key} is not used by ${action}`, 'VALIDATION_ERROR');
        }
      }
      const { reportId, contactId, mode, email, name } = parsed.value;

      try {
        const permissions = (await aiCallerPermissions(auth)) ?? undefined;
        if (action === 'list') {
          const out = await listReportRecipients(reportId, auth, permissions);
          if (!out.ok) return refusal(out);
          const page = capped(out.value, LIST_MAX);
          return bounded({ reportId, count: page.showing, total: page.total, truncated: page.truncated, recipients: page.rows });
        }

        if (action === 'add') {
          const out = await addReportRecipient(reportId, auth, permissions, { contactId: contactId!, ...(mode ? { mode } : {}) }, { requireDeliveryGate: true });
          if (!out.ok) return refusal(out);
          // 200 = the contact was already a recipient (onConflictDoNothing): nothing changed, nothing to audit.
          if (out.status !== 201) return json({ added: false, alreadyPresent: true, reportId, contactId });
          auditToolWrite(auth, {
            orgId: out.orgId ?? null, action: 'report.recipient.add',
            resourceType: 'report', resourceId: reportId, details: { contactId, mode: mode ?? 'add' },
          });
          return json({ added: true, reportId, contactId, mode: mode ?? 'add', recipient: out.value });
        }

        if (action === 'remove') {
          const out = await removeReportRecipient(reportId, auth, permissions, contactId!);
          if (!out.ok) return refusal(out);
          auditToolWrite(auth, {
            orgId: out.orgId ?? null, action: 'report.recipient.remove',
            resourceType: 'report', resourceId: reportId, details: { contactId },
          });
          return json({ deleted: true, reportId, contactId });
        }

        const out = await convertReportRecipient(
          reportId, auth, permissions, { email: email!, ...(name ? { name } : {}) }, auth.user.id,
          { requireDeliveryGate: true, requireLegacyAddress: true },
        );
        if (!out.ok) return refusal(out);
        const { orgId, contact, createdContact } = out.value;
        if (createdContact) {
          const event = contactCreateAuditEvent(createdContact);
          auditToolWrite(auth, {
            orgId, action: event.action, resourceType: event.resourceType, resourceId: event.resourceId,
            resourceName: event.resourceName, details: event.details,
          });
        }
        auditToolWrite(auth, {
          orgId, action: 'report.recipient.convert', resourceType: 'report', resourceId: reportId,
          details: { contactId: contact.id, createdContact: Boolean(createdContact) },
        });
        return json({ converted: true, reportId, contact, createdContact: Boolean(createdContact) });
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}
