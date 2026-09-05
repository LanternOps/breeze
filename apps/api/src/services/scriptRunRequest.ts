/**
 * The ONE validation contract for "run this saved script on these devices".
 *
 * Lives in a dependency-free leaf module (only zod + the shared parameter
 * schema) rather than in `routes/scripts.ts`, so a non-route caller can reuse
 * the exact same schema object without importing a route module. That matters
 * for the AI tool path (#4888): `run_script` and the Script Builder's
 * `execute_script_on_device` let an assistant choose the run context, and an
 * assistant-chosen `runAs` must clear the SAME gate a human-chosen one does.
 * A second, hand-copied enum next to the tool definition is exactly how the
 * two would drift — and the direction they drift in is "the model can ask for
 * something the API would have refused a person".
 *
 * `routes/scripts.ts` re-exports `executeScriptSchema` so its existing
 * importers (and its co-located schema test) keep their import path.
 */
import { z } from 'zod';
import { scriptParametersSchema } from '@breeze/shared';

export const executeScriptSchema = z
  .object({
    // Capped at 500: queueCommand fires an un-awaited, fire-and-forget audit
    // transaction PER DEVICE for 'script' commands (AUDITED_COMMANDS in
    // commandQueue.ts). The dispatch loop in scriptExecution.ts is sequential
    // and awaited, but those audit transactions are not — an unbounded batch
    // would launch hundreds of concurrent transactions against a pool sized
    // for far fewer while this request also holds a connection, the same
    // pool-starvation shape that has caused prior production incidents.
    deviceIds: z.array(z.string().guid()).min(1).max(500, {
      message: 'Cannot target more than 500 devices in a single script execution',
    }),
    // #3409 PR2 Task 7: the ONE script-parameter schema (@breeze/shared) —
    // accepts string/number/boolean values, canonicalized to strings once at
    // dispatch (scriptDispatch.ts). The 64KB cap is kept ON TOP of the
    // schema's own count/length caps: it bounds the raw JSON body size this
    // route ever accepts, independent of the canonicalized wire form.
    parameters: scriptParametersSchema.refine(
      (val) => JSON.stringify(val).length <= 65536,
      { message: 'Object too large (max 64KB)' }
    ).optional(),
    // Deliberately omits 'automation' even though the DB enum has it (#3162):
    // that value is provenance minted only by the automation runtime, and an
    // API caller must not be able to forge it. Don't "fix" this to match the
    // column type.
    triggerType: z.enum(['manual', 'scheduled', 'alert', 'policy']).optional(),
    // 'elevated' is deliberately NOT selectable at launch time — it stays a
    // property of the saved script. Widening this enum would let any caller of
    // THIS schema escalate a user-context script to an elevated one from the
    // request body.
    //
    // Scope note, because the narrower claim is the honest one: this schema
    // governs `POST /scripts/:id/execute`, the AI `run_script` /
    // `execute_script_on_device` tools, and the fleet remediate route. It does
    // NOT govern automation ACTIONS — `normalizeAutomationActions`
    // (services/automationRuntime.ts) accepts a stored `runAs: 'elevated'` on
    // purpose, since it also runs on the execute path and must not take a live
    // automation offline. The assistant route into that gap is closed
    // separately (`rejectElevatedAutomationActions` in aiToolsConfigPolicy.ts);
    // a raw `POST /automations` call can still author one, which pre-dates
    // #4888 and is called out as follow-up work rather than silently implied
    // to be covered here.
    runAs: z.enum(['system', 'user']).optional(),
    // Windows session to run the user-context script in (RDS session
    // targeting). Session ids are per-device, hence single-device only.
    // min(1): session 0 is never an interactive session — the agent rejects
    // it with a typed error, but rejecting here saves the round trip
    // (amended during execution after the Task 6 session-0 finding).
    targetSessionId: z.number().int().min(1).max(65535).optional(),
  })
  .refine((d) => d.targetSessionId == null || d.runAs === 'user', {
    message: 'targetSessionId requires runAs=user',
    path: ['targetSessionId'],
  })
  .refine((d) => d.targetSessionId == null || d.deviceIds.length === 1, {
    message: 'targetSessionId requires exactly one device',
    path: ['targetSessionId'],
  });

export type ExecuteScriptRequest = z.infer<typeof executeScriptSchema>;

/**
 * The run-context arguments an AI tool may supply when launching a script.
 *
 * FOUR declarations of `run_script`'s input shape exist (the Anthropic-native
 * definition in `aiToolsScripts.ts`, the zod validator in `aiToolSchemas.ts`,
 * the agent-SDK MCP tool in `aiAgentSdkTools.ts`, and the Script Builder's
 * `execute_script_on_device` in `scriptBuilderTools.ts`). Any one of them
 * omitting these fields means the model simply cannot express a run context on
 * that surface, so they are defined ONCE here and spread into all four.
 *
 * The enum deliberately matches `executeScriptSchema.runAs` exactly, 'elevated'
 * included in its exclusion: an assistant must not be able to ask for a run
 * context the API would refuse a person — head-on, or sideways through a
 * config policy (see `rejectElevatedAutomationActions`).
 */
export const aiRunContextInputShape = {
  runAs: z
    .enum(['system', 'user'])
    .optional()
    .describe(
      "Run context override. 'system' runs with full machine privileges (LocalSystem / root); " +
        "'user' runs inside the logged-in user's desktop session, which is required for anything " +
        'that touches the user profile, mapped drives, or the interactive desktop. Omit to use the ' +
        "script's saved default. This does not bypass approval — the run still needs the same " +
        'approval any script run needs, and the approver is shown the context you chose.'
    ),
  targetSessionId: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe(
      "Windows session id to run a runAs='user' script in (RDS / multi-session hosts). Only valid " +
        "together with runAs='user' and exactly one device; omit to use the active interactive session."
    ),
};

/**
 * The same two fields as a raw JSON-schema fragment, for the Anthropic-native
 * tool definitions in `aiToolsScripts.ts` (which hand-write `input_schema`
 * rather than deriving it from zod).
 */
export const AI_RUN_CONTEXT_JSON_SCHEMA_PROPERTIES = {
  runAs: {
    type: 'string' as const,
    enum: ['system', 'user'],
    description:
      "Run context override: 'system' (full machine privileges) or 'user' (the logged-in user's " +
      "desktop session). Omit to use the script's saved default. Still requires the same approval " +
      'as any script run, and the approver is shown the context you chose.',
  },
  targetSessionId: {
    type: 'number' as const,
    description:
      "Windows session id for a runAs='user' run. Only valid with runAs='user' and exactly one device.",
  },
};
