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

/** Shape-only UUID guard: only a real ticket id's prefix is turned into a pattern. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function titleCaseWords(snake: string): string {
  return snake
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join(' ');
}

/** Call-specific four-eyes copy: every cancellation is terminal and names its term. */
export function describePax8Submit(input: Record<string, unknown>): string {
  const text = (value: unknown) => typeof value === 'string' ? value.replace(/[\r\n\t]/g, ' ').slice(0, 255) : '?';
  const company = input.expectedCompany && typeof input.expectedCompany === 'object'
    ? input.expectedCompany as Record<string, unknown> : {};
  const lines = Array.isArray(input.expectedLines) ? input.expectedLines as Array<Record<string, unknown>> : [];
  const labels: Record<string, string> = { new_subscription: 'new subscriptions', change_quantity: 'quantity changes', cancel: 'cancellations' };
  const counts = Object.entries(labels).map(([action, label]) => `${lines.filter(l => l.action === action).length} ${label}`).join(', ');
  return `Place a real, billable Pax8 order that cannot be undone for ${text(company.name)} (${text(company.pax8CompanyId)}): ${counts}. Cost is estimated at Pax8's current rate, re-checked before sending. `
    + lines.map(line => `${line.action === 'cancel' ? 'CANCEL (terminal)' : titleCaseWords(text(line.action))} ${text(line.productName)} [${text(line.pax8ProductId)}]: ${line.action === 'new_subscription' ? 'new' : text(line.fromQuantity)} → ${text(line.quantity)}, ${text(line.unitCost)} ${text(line.currency)} per seat / ${text(line.billingTerm)}, commitment ${text(line.commitmentTerm)}${line.cancellationFeeApplied === true ? ', cancellation fee applies' : ''}`).join('; ');
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

/** Shared consequence copy for chat, approval cards and deferred impact descriptions. */
export function describePax8Action(toolName: string, action?: string | null): string | null {
  if (toolName === 'manage_pax8_subscriptions') {
    switch (action) {
      case 'sync': return 'Sync Pax8 snapshots for every organization of the partner using its vendor credentials';
      case 'link': return 'Link a Pax8 subscription: decides which contract line later Pax8 orders bill';
      case 'unlink': return 'Unlink a Pax8 subscription: staged changes on this subscription will be refused; observation history is lost';
    }
  }
  if (toolName === 'manage_pax8_orders') {
    switch (action) {
      case 'create_draft': return 'Create or reuse a Pax8 order draft';
      case 'add_line': return 'Add a line to a Pax8 order draft';
      case 'update_line': return 'Edit a Pax8 order draft line';
      case 'remove_line': return 'Remove a Pax8 order draft line';
      case 'submit': return 'Place a real, billable Pax8 order that cannot be undone; cost is estimated at Pax8’s current rate';
      case 'reconcile': return 'Reconcile a previously approved Pax8 attempt from vendor evidence and record billing quantity; ambiguous writes remain unknown';
      case 'preflight': return 'Run a dry run that sends the staged order content to Pax8 (isMock)';
    }
  }
  return null;
}

/**
 * Human headline for an approval-gated call when no call-specific description
 * exists: never the bare tool identifier (#9657).
 */
export function humanizeToolAction(toolName: string, action?: string | null): string {
  const pax8 = describePax8Action(toolName, action);
  if (pax8) return pax8;
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
  const pax8 = describePax8Action(toolName, str(input.action));
  if (pax8) return pax8;
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

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * The `manage_patches` install headline (aiGuardrails.ts
 * `buildApprovalDescription`): `Install 1 patch on device 6eae0f70...` or
 * `Install 3 patches on 2 devices`. One device is named by the
 * `on device <id>...` stub the approval surfaces swap for its name
 * (approvalDeviceName.ts `argumentDeviceId`), as `run_script` does (#11979).
 * Counts always come from the arguments.
 */
export function patchInstallHeadline(input: Record<string, unknown>): string {
  const devices = Array.isArray(input.deviceIds) ? input.deviceIds : [];
  const [only] = devices;
  const target = devices.length === 1 && typeof only === 'string' && only.length > 0
    ? `device ${only.slice(0, 8)}...`
    : plural(devices.length, 'device', 'devices');
  return `${patchInstallCountText(input)} on ${target}`;
}

/** `Install 3 patches`: the part of the install headline that patch names replace. */
function patchInstallCountText(input: Record<string, unknown>): string {
  return `Install ${plural(countOf(input.patchIds), 'patch', 'patches')}`;
}

/**
 * Does `text` LEAD with the install headline built from THESE arguments? The
 * intent service reads patch names only when it does, and the label builder
 * rewrites only that headline, so a caller-supplied label, or text that merely
 * mentions an install, is never relabelled.
 */
export function hasPatchInstallHeadline(toolName: string, text: string, input: Record<string, unknown>): boolean {
  if (toolName !== 'manage_patches' || input.action !== 'install') return false;
  return text.startsWith(`${patchInstallCountText(input)} on `);
}

/** Shorten a name to `max` UTF-16 units (the unit the cap counts), keeping a quoted title quoted. Null when nothing useful fits. */
function fitPatchName(name: string, max: number): string | null {
  if (name.length <= max) return name;
  const quoted = name.length >= 2 && name.startsWith('"') && name.endsWith('"');
  // A KB number is not cut: half of one names a different patch.
  if (!quoted || max < 8) return null;
  let inner = '';
  for (const char of Array.from(name.slice(1, -1).replace(/…$/, ''))) {
    if (inner.length + char.length + '"…"'.length > max) break;
    inner += char;
  }
  return `"${inner.trimEnd()}…"`;
}

/**
 * Put the resolved patch names in place of the count: one patch reads
 * `Install KB5034441 on KIT`, several read `Install KB5034441, "Chrome 120"
 * +3 more on 2 devices`. "+N more" counts from the ARGUMENTS, so a patch that
 * did not resolve is still counted. The text after the count (the device, or
 * the device count) is trusted and must survive the length cap, so the names
 * are fitted to what is left of it; when no name fits, the count stays.
 */
function namePatchesInHeadline(label: string, input: Record<string, unknown>, names: string[]): string {
  const countText = patchInstallCountText(input);
  const tail = label.slice(countText.length);
  const total = countOf(input.patchIds);
  const budget = MAX_LABEL_LENGTH - 'Install '.length - tail.length;
  const more = (shown: number) => (total > shown ? ` +${total - shown} more` : '');
  const fits = (text: string) => text.length <= budget;

  const two = names.slice(0, 2);
  let nameText: string | null = `${two.join(', ')}${more(two.length)}`;
  if (!fits(nameText)) {
    const suffix = more(1);
    const first = fitPatchName(names[0]!, budget - suffix.length);
    nameText = first ? `${first}${suffix}` : null;
  }
  return nameText ? `Install ${nameText}${tail}` : label;
}

export interface ActionLabelInput {
  toolName: string;
  input: Record<string, unknown>;
  /** The guardrail's call-specific description (`createActionIntent`'s `reason`). */
  reason?: string | null;
  /** Resolved target hostname, so "on device 6eae0f70..." becomes "on KIT". */
  deviceHostname?: string | null;
  /**
   * #11674: the ticket this call acts on and its resolved number, so
   * "ticket #2aad0601..." becomes "ticket T-2026-0001". Only the stub built
   * from THIS id is replaced. The number only, never ticket content.
   */
  ticketId?: string | null;
  ticketNumber?: string | null;
  /**
   * A `manage_patches` install's resolved patch names, display-ready and in
   * argument order (approvalPatchNames.ts), so `Install 3 patches on 2
   * devices` names the patches. Applied only when the label leads with the
   * install headline built from THIS call's arguments.
   */
  patchNames?: string[] | null;
}

export function buildActionLabel(args: ActionLabelInput): string {
  const base = str(args.reason) ?? fallbackLabel(args.toolName, args.input);
  let label = softenLeadingShout(base);
  const host = str(args.deviceHostname);
  if (host) label = label.replace(DEVICE_ID_STUB, `on ${host}`);
  const ticketNumber = str(args.ticketNumber);
  if (ticketNumber && args.ticketId && UUID_SHAPE.test(args.ticketId)) {
    const stub = new RegExp(`\\bticket #${args.ticketId.slice(0, 8)}\\.\\.\\.`, 'gi');
    label = label.replace(stub, () => `ticket ${ticketNumber}`);
  }
  label = label.replace(/\s+/g, ' ').trim();
  // After the device and ticket rewrites, so a name can never be mistaken for
  // a stub and given a hostname or a ticket number.
  const patchNames = (args.patchNames ?? []).filter((name) => str(name) !== null);
  if (patchNames.length > 0 && hasPatchInstallHeadline(args.toolName, label, args.input)) {
    label = namePatchesInHeadline(label, args.input, patchNames);
  }
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

/**
 * #11674 — does `text` carry the `ticket #<8 hex>...` stub for THIS call's
 * ticket? The intent service reads the ticket number only when it does, so the
 * many labels with no ticket stub cost no read.
 */
export function hasTicketIdStub(text: string, ticketId: string): boolean {
  return text.toLowerCase().includes(`ticket #${ticketId.slice(0, 8).toLowerCase()}...`);
}
