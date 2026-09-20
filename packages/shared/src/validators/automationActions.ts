import { z } from 'zod';

/**
 * Automation trigger + action vocabulary.
 *
 * Extracted from validators/index.ts (#5289) into a LEAF module: monitors.ts
 * needs `automationActionSchema` (a monitor's responses reuse it verbatim), and
 * importing it from the barrel created a circular initialisation — index.ts
 * re-exports monitors.ts, so under a plain ESM loader monitors.ts evaluated
 * first and hit `Cannot access 'automationActionSchema' before initialization`
 * (it did NOT reproduce under vitest's loader, only in tsx/node — db:check-drift
 * was what caught it). Nothing else moved, and index.ts re-exports this file, so
 * every existing import path still resolves.
 */
export const automationTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('schedule'),
    cron: z.string(),
    timezone: z.string().default('UTC')
  }),
  z.object({
    type: z.literal('event'),
    event: z.string(),
    durationMinutes: z.number().optional(),
    // #5289: compiled monitor automations fire on `alert.triggered` but must
    // only run for THEIR OWN alert rule, so the trigger carries the narrowing
    // filter the runtime already reads (`normalizeAutomationTrigger` passes
    // `filter` through). Free-form on purpose — the runtime matches by key.
    filter: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('webhook'),
    secret: z.string().min(1)
  }),
  z.object({
    type: z.literal('manual')
  })
]);

export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_script'),
    scriptId: z.string().guid(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    // #4888 — narrowed from a bare string now that the automation form
    // actually exposes this control. Absent = use the script's saved default,
    // which is what `automationRuntime.executeRunScriptAction` resolves it to.
    // 'elevated' stays accepted here because a stored action may legitimately
    // carry it (it is a real value of the `script_run_as` enum), even though
    // the form only offers system/user.
    runAs: z.enum(['system', 'user', 'elevated']).optional(),
    // #5128 W4 — what to do when the target device is offline at dispatch
    // time. 'queue' (the default) persists the command with a delivery
    // deadline and the agent claims it on its next successful heartbeat;
    // 'skip' reproduces the pre-#5128 behaviour of failing the step with
    // `device_offline`. Defaulted rather than optional so a stored action
    // authored before this field existed reads as 'queue'.
    whenOffline: z.enum(['queue', 'skip']).default('queue'),
  }),
  z.object({
    type: z.literal('send_notification'),
    notificationChannelId: z.string().guid(),
    title: z.string().optional(),
    message: z.string().optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  }),
  z.object({
    type: z.literal('create_alert'),
    alertSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    alertMessage: z.string(),
    alertTitle: z.string().optional(),
  }),
  z.object({
    type: z.literal('execute_command'),
    command: z.string().optional(),
    // #5291 W04 — an OPTIONAL, explicit intent discriminator. Spec §Responses:
    // an execute_command of kind 'restart_service' on a `service` monitor
    // compiles to `auto_restart: true` on the delivered watch, so the restart
    // still happens locally and offline. It is a declared field rather than a
    // sniff of the free-text `command` on purpose: a behaviour-changing flag
    // must never be inferred from a shell string that varies by OS, locale and
    // quoting. Additive and optional, so every existing action still parses.
    kind: z.literal('restart_service').optional(),
    maxAttempts: z.number().int().min(0).max(50).optional(),
    cooldownSeconds: z.number().int().min(30).max(86400).optional(),
    shell: z.enum(['bash', 'powershell', 'cmd']).optional(),
    // #5128 W4 — see the run_script arm above.
    whenOffline: z.enum(['queue', 'skip']).default('queue'),
  }).refine((action) => action.kind === 'restart_service' || (action.command?.trim().length ?? 0) > 0, {
    message: 'command is required unless kind is restart_service',
    path: ['command'],
  }),
  z.object({
    type: z.literal('deploy_software'),
    catalogId: z.string().guid(),
  }),
  // AI agents wave 3d (#3824): a system-managed action, seeded alongside a
  // triage agent — never authored in the UI. It carries NO config on
  // purpose: the agent is resolved through automations.managed_by_agent_id
  // and the device comes from the triggering event's binding, so severity/
  // site/tag filtering has exactly one home (the agent policy) and cannot
  // drift against the automation row. `.strict()` so a caller cannot
  // smuggle an agentId past that resolution.
  z.object({
    type: z.literal('ai_triage'),
  }).strict(),
]);
