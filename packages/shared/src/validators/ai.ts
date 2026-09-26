import { z } from 'zod';
import { scriptParameterDefinitionsSchema } from './scriptParameterDefinitions';

// ============================================
// Page Context Validators
// ============================================

export const aiTopologyPageContextSchema = z.object({
  type: z.literal('topology'),
  siteId: z.string().guid(),
  subject: z.object({
    kind: z.enum(['node', 'relationship']),
    id: z.string().guid()
  }).strict(),
  view: z.enum(['overview', 'physical', 'logical']),
  graphRevision: z.string().regex(/^(0|[1-9]\d{0,19})$/)
}).strict();

export const aiPageContextSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('device'),
    id: z.string().guid(),
    hostname: z.string(),
    // Client-side tenant hint only (#5684) — see AiPageContext. Never used for
    // authorization: createSession resolves the org from the device row.
    orgId: z.string().guid().optional(),
    os: z.string().optional(),
    status: z.string().optional(),
    ip: z.string().optional()
  }),
  z.object({
    type: z.literal('alert'),
    id: z.string().guid(),
    title: z.string(),
    severity: z.string().optional(),
    deviceHostname: z.string().optional()
  }),
  z.object({
    type: z.literal('dashboard'),
    orgName: z.string().optional(),
    deviceCount: z.number().optional(),
    alertCount: z.number().optional()
  }),
  z.object({
    type: z.literal('custom'),
    label: z.string(),
    data: z.record(z.string(), z.unknown())
  }),
  // Topology M4 (#6000): the selection an "Explain this" investigation starts
  // from. Only IDs — never evidence bodies, labels, org ids or credentials. The
  // server authorizes `siteId` at session creation and PINS the session to it
  // (ai_sessions.topology_site_id, M4-D2); a later page context never moves it.
  aiTopologyPageContextSchema
]);

// ============================================
// Session Validators
// ============================================

export const createAiSessionSchema = z.object({
  pageContext: aiPageContextSchema.optional(),
  model: z.string().max(100).optional(),
  title: z.string().max(255).optional()
});

export const sendAiMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  pageContext: aiPageContextSchema.optional()
});

export const approveToolSchema = z.object({
  approved: z.boolean()
});

export const approvePlanSchema = z.object({
  approved: z.boolean()
});

export const aiApprovalModeSchema = z.enum(['per_step', 'action_plan', 'auto_approve', 'hybrid_plan']);

export const pauseAiSchema = z.object({
  paused: z.boolean()
});

// ============================================
// Query Validators
// ============================================

export const aiSessionQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['active', 'closed', 'expired']).optional()
});

// ============================================
// Script Builder Validators
// ============================================

export const scriptBuilderContextSchema = z.object({
  scriptId: z.string().guid().optional(),
  targetDeviceId: z.string().guid().optional(),
  lastTestExecutionId: z.string().guid().optional(),
  editorSnapshot: z.object({
    name: z.string().max(255).optional(),
    content: z.string().max(500_000).optional(),
    description: z.string().max(2000).optional(),
    language: z.enum(['powershell', 'bash', 'python', 'cmd']).optional(),
    osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
    // Scripts imported from loose .ps1/.sh files (and older rows) carry a NULL
    // category; the editor echoes it verbatim, so accept null and drop it.
    category: z.string().max(100).nullish().transform((v) => v ?? undefined),
    // The one definition schema (#3409 PR3). The 50-item cap is kept as it
    // was — it is narrower than the shared MAX_SCRIPT_PARAMETERS (64) because
    // this snapshot is echoed into an LLM context window, not because the
    // parameter list itself is bounded differently.
    parameters: scriptParameterDefinitionsSchema.max(50).optional(),
    runAs: z.enum(['system', 'user', 'elevated']).optional(),
    // The editor snapshot echoes the current form values, which for legacy
    // scripts may hold timeouts saved under the old 86400 intake cap. Tolerate
    // those (don't fail session creation on an unrelated field) but clamp to
    // 3600 — the agent executor's hard MaxTimeout (#2398).
    timeoutSeconds: z.number().min(1).max(86400).transform((v) => Math.min(v, 3600)).optional(),
  }).optional(),
});

export const createScriptBuilderSessionSchema = z.object({
  context: scriptBuilderContextSchema.optional(),
  title: z.string().max(255).optional(),
});
