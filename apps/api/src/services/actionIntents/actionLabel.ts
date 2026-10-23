/**
 * The one-line, human headline for an action-intent approval.
 *
 * Shown as the 28pt title on the mobile takeover, as the push notification
 * body, and in the in-app bell. It used to be the raw call signature
 * (`manage_services(deviceId=6eae0f70-…, action=restart, serviceName=Spooler)`),
 * which is audit data, not something a technician should have to parse with
 * their thumb on Approve. The signature is still persisted as
 * `targetSummary` / `actionArguments` for the details card.
 */

const MAX_LABEL_LENGTH = 140;

/** `on device 6eae0f70...` as emitted by aiGuardrails.buildApprovalDescription. */
const DEVICE_ID_STUB = /\bon device [0-9a-f]{8}\.\.\./i;

export function titleCaseWords(snake: string): string {
  return snake
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join(' ');
}

/**
 * Human headlines for approval-gated tools whose prettified identifier reads
 * poorly (#9657). Tools absent here fall back to `titleCaseWords(toolName)`.
 * Display text only: nothing here feeds approval, tier or permission logic.
 */
const TOOL_HEADLINES: Record<string, string> = {
  remediate_vulnerability: 'Remediate vulnerabilities',
  restore_snapshot: 'Restore backup snapshot',
  trigger_backup: 'Start a backup',
  trigger_hyperv_backup: 'Start a Hyper-V backup',
  trigger_mssql_backup: 'Start a SQL Server backup',
  m365_disable_user: 'Disable Microsoft 365 user',
  m365_reset_password: 'Reset Microsoft 365 password',
  m365_revoke_sessions: 'Revoke Microsoft 365 sign-in sessions',
  m365_remove_license: 'Remove Microsoft 365 license',
  m365_assign_license: 'Assign Microsoft 365 license',
  m365_remove_from_group: 'Remove user from Microsoft 365 group',
  m365_add_to_group: 'Add user to Microsoft 365 group',
  m365_retire_intune_device: 'Retire Intune device',
  m365_create_user: 'Create Microsoft 365 user',
  m365_set_auto_reply: 'Set Microsoft 365 auto-reply',
};

/** Object noun for `manage_<noun>` tools, so `void` reads `Void invoice`. */
const MANAGE_TOOL_NOUNS: Record<string, string> = {
  manage_invoices: 'invoice',
  manage_quotes: 'quote',
  manage_contracts: 'contract',
};

/**
 * Human headline for an approval-gated call when no call-specific description
 * exists: never the bare tool identifier (#9657).
 */
export function humanizeToolAction(toolName: string, action?: string | null): string {
  const verb = action ? action.replace(/[_\s]+/g, ' ').trim().toLowerCase() : '';
  const noun = MANAGE_TOOL_NOUNS[toolName];
  const nounPhrase = verb.endsWith(' payment') ? `${noun} payment` : noun;
  if (noun && verb.endsWith(' payment')) {
    const v = verb.replace(/ payment$/, '');
    return `${v.charAt(0).toUpperCase()}${v.slice(1)} ${nounPhrase}`;
  }
  if (noun && verb) return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${noun}`;
  const head = TOOL_HEADLINES[toolName] ?? titleCaseWords(toolName);
  return verb ? `${head}: ${verb}` : head;
}

/** `RESTART service "Spooler"` → `Restart service "Spooler"`. */
function softenLeadingShout(text: string): string {
  return text.replace(/^([A-Z]{2,})(?=\s)/, (w) => w.charAt(0) + w.slice(1).toLowerCase());
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** `alice@acme.example` -> `acme.example`. Null for a value with no `@`-domain. */
function emailDomain(value: string): string | null {
  const at = value.lastIndexOf('@');
  return at === -1 || at === value.length - 1 ? null : value.slice(at + 1).toLowerCase();
}

/**
 * Mirrors aiGuardrails.ts's `externalDestinationFlag` (duplicated rather than
 * imported — this module stays a light, dependency-free formatter).
 * `sourceEmail` (the tool's own `userEmail`/`ownerEmail` argument) is used as
 * a stand-in for the connected Google workspace's verified/primary domain:
 * this fallback path has no connection lookup available (it runs outside any
 * DB/org context), so it cannot confirm the source mailbox is actually on the
 * workspace's real domain — a caller who fully controls the tool arguments
 * controls both sides of this comparison. Display-only, and worded to reflect
 * that: it flags a domain difference between the two supplied addresses, not
 * a verified-external destination.
 */
function externalDestinationFlag(sourceEmail: string | null, destEmail: string | null): string {
  if (!sourceEmail || !destEmail) return '';
  const sourceDomain = emailDomain(sourceEmail);
  const destDomain = emailDomain(destEmail);
  if (!sourceDomain || !destDomain || sourceDomain === destDomain) return '';
  return ' (different domain from source mailbox)';
}

/**
 * The deferred human-fanout path (intentService.ts's runHumanFanout-from-
 * timeout branch) never threads the guardrail's `reason`, so these
 * mail/calendar tools relied entirely on the generic fallback below — which
 * showed the bare tool name, with no destination, on the mobile
 * takeover/push surface. Keyed by tool name so only these external-
 * destination tools take this branch; every other tool's fallback is
 * unchanged. `requiresField`, when set, must be strictly `true` in `input`
 * before `dest` is shown — mirrors `google_disable_forwarding`'s own
 * `removeAddress` gate in aiGuardrails.ts's `buildApprovalDescription`
 * (a disable-without-`removeAddress` call has no destination to show).
 */
const GOOGLE_DESTINATION_FIELDS: Record<string, { source: string; dest: string; verb: string; requiresField?: string }> = {
  google_set_forwarding: { source: 'userEmail', dest: 'forwardTo', verb: 'Forward mail to' },
  google_add_mail_delegate: { source: 'userEmail', dest: 'delegateEmail', verb: 'Grant mail delegate access to' },
  google_share_calendar: { source: 'ownerEmail', dest: 'shareWithEmail', verb: "Share calendar with" },
  google_disable_forwarding: { source: 'userEmail', dest: 'forwardTo', verb: 'Remove forwarding address', requiresField: 'removeAddress' },
};

/**
 * Fallback when the guardrail produced no description: the tool name in
 * words plus the one or two arguments a human would actually recognise.
 */
function fallbackLabel(toolName: string, input: Record<string, unknown>): string {
  const googleDestination = GOOGLE_DESTINATION_FIELDS[toolName];
  if (googleDestination && (!googleDestination.requiresField || input[googleDestination.requiresField] === true)) {
    const source = str(input[googleDestination.source]);
    const dest = str(input[googleDestination.dest]);
    if (dest) {
      return `${googleDestination.verb} ${dest}${externalDestinationFlag(source, dest)}`;
    }
  }

  const head = TOOL_HEADLINES[toolName] ?? titleCaseWords(toolName);
  const detail = [
    str(input.action) ?? str(input.commandType),
    str(input.serviceName) ?? str(input.processName) ?? str(input.scriptName) ?? str(input.name),
  ].filter((v): v is string => v !== null);
  return detail.length > 0 ? `${head}: ${detail.join(' ')}` : head;
}

export interface ActionLabelInput {
  toolName: string;
  input: Record<string, unknown>;
  /** The guardrail's call-specific description (`createActionIntent`'s `reason`). */
  reason?: string | null;
  /** Resolved target hostname, so "on device 6eae0f70..." becomes "on KIT". */
  deviceHostname?: string | null;
}

export function buildActionLabel(args: ActionLabelInput): string {
  const base = str(args.reason) ?? fallbackLabel(args.toolName, args.input);
  let label = softenLeadingShout(base);
  const host = str(args.deviceHostname);
  if (host) label = label.replace(DEVICE_ID_STUB, `on ${host}`);
  label = label.replace(/\s+/g, ' ').trim();
  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…` : label;
}

/**
 * #5363 — does `text` carry the id stub for THIS call's device?
 *
 * `buildActionLabel` above rewrites any `on device <8 hex>...` it finds, so a
 * caller must only hand it a `deviceHostname` once it knows the stub actually
 * names the device that hostname belongs to. Matched on the call's own id
 * prefix, literally (the rule the chat bridge in aiAgentSdk.ts applied before
 * #5363 moved this into the intent service), so a caller-supplied label that
 * happens to mention some OTHER device's id is never relabelled — and so the
 * resolving read below it is skipped entirely for the many tools whose
 * description has no device stub at all.
 */
export function hasDeviceIdStub(text: string, deviceId: string): boolean {
  return text.toLowerCase().includes(`on device ${deviceId.slice(0, 8).toLowerCase()}...`);
}
