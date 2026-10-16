/**
 * Frozen wire shapes for the workstation tier of caller verification
 * (#6354 W02). A LEAF module (zod only) so both agent transports, the
 * reconciliation worker and the deliverer can import it without pulling the
 * service graph into their closures.
 *
 * Command (`device_commands.payload` for type `caller_verify`): what the
 * agent forwards to the console user's Assist helper. There is no approval
 * field and no principal: the human's choice comes back in the result, and
 * the agent — never the helper — supplies the OS principal.
 *
 * Result (`stdout` JSON on HTTP, the parsed `result` on WS):
 *   { delivered, choice?, principal?, helperVersion?, error? }
 * `choice` is one of the three offered numbers, `not_me` or `timeout`.
 * `delivered:false` carries an `error` and never a choice.
 */
import { z } from 'zod';

export const CALLER_VERIFY_COMMAND = 'caller_verify' as const;

/** Bounds shared by the API, the agent and the helper (`timeoutMs`). */
export const WORKSTATION_TIMEOUT_MIN_MS = 30_000;
export const WORKSTATION_TIMEOUT_MAX_MS = 300_000;

export const WORKSTATION_UNDELIVERABLE_ERRORS = ['no_session_for_user', 'session_not_console', 'helper_outdated'] as const;
export type WorkstationUndeliverableError = (typeof WORKSTATION_UNDELIVERABLE_ERRORS)[number];

const numberChoice = z.string().regex(/^\d{2}$/);

export const workstationCommandSchema = z.object({
  verificationId: z.string().uuid(),
  username: z.string().min(1).max(255),
  technicianName: z.string().min(1).max(255),
  orgName: z.string().min(1).max(255),
  actionLabel: z.string().min(1).max(255),
  targetLabel: z.string().min(1).max(320),
  reverseCode: z.string().regex(/^\d{4}$/),
  choices: z.tuple([numberChoice, numberChoice, numberChoice]),
  timeoutMs: z.number().int().min(WORKSTATION_TIMEOUT_MIN_MS).max(WORKSTATION_TIMEOUT_MAX_MS),
}).strict().refine((value) => new Set(value.choices).size === 3, { message: 'choices must be distinct' });

export type WorkstationCommand = z.infer<typeof workstationCommandSchema>;

const principalSchema = z.object({
  sid: z.string().regex(/^S-\d+(?:-\d+)+$/).max(184).optional(),
  uid: z.number().int().min(0).max(4294967295).optional(),
  username: z.string().min(1).max(255),
  upn: z.string().min(1).max(320).optional(),
}).refine((p) => (p.sid !== undefined) !== (p.uid !== undefined), { message: 'exactly one of sid or uid' });

export const workstationResultSchema = z.object({
  delivered: z.boolean(),
  choice: z.union([numberChoice, z.literal('not_me'), z.literal('timeout')]).optional(),
  principal: principalSchema.optional(),
  helperVersion: z.string().max(64).optional(),
  error: z.enum(WORKSTATION_UNDELIVERABLE_ERRORS).optional(),
}).refine((value) => (value.delivered ? value.error === undefined : value.choice === undefined), {
  message: 'delivered results carry no error; undelivered results carry no choice',
});

export type WorkstationResult = z.infer<typeof workstationResultSchema>;

/**
 * Parse an agent result from either transport. HTTP carries the JSON in
 * `stdout`; the WS leg also re-parses stdout into `result`. Stdout wins when
 * both are present (it is the agent's literal output). Anything that does not
 * match the frozen shape is null — callers treat null as "invalid result",
 * never as an approval.
 */
export function readWorkstationResult(stdout: string | undefined, result: unknown): WorkstationResult | null {
  let value: unknown = result;
  if (typeof stdout === 'string' && stdout.length > 0) {
    try {
      value = JSON.parse(stdout);
    } catch {
      return null;
    }
  }
  const parsed = workstationResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
