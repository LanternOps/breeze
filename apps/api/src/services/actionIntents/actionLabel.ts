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

function titleCaseWords(snake: string): string {
  return snake
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join(' ');
}

/** `RESTART service "Spooler"` → `Restart service "Spooler"`. */
function softenLeadingShout(text: string): string {
  return text.replace(/^([A-Z]{2,})(?=\s)/, (w) => w.charAt(0) + w.slice(1).toLowerCase());
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Fallback when the guardrail produced no description: the tool name in
 * words plus the one or two arguments a human would actually recognise.
 */
function fallbackLabel(toolName: string, input: Record<string, unknown>): string {
  const head = titleCaseWords(toolName);
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
