/**
 * AI for Office — session-loop helpers shared by routes/clientAi/sessions.ts.
 *
 * The synthetic AuthContext mirrors the helper-chat shape
 * (routes/helper/index.ts:133-160): an org-pinned 'organization'-scope context
 * whose "user" is the portal user, so streamingSessionManager's background
 * callbacks (recordUsageFromSdkResult via session.auth.orgId, audit actor ids)
 * and RLS DB contexts all resolve to the client org. No helperDeviceId — the
 * client surface has no device axis.
 */

import { eq } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { getRedis } from './redis';
import { rateLimiter } from './rate-limit';
import type { ClientAiOrgPolicy } from './clientAiPolicy';

export const DEFAULT_CLIENT_AI_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * The Excel-assistant system prompt (spec §5/§11; pinned in the plan).
 * Stored on the ai_sessions row at create time, passed to getOrCreate with
 * injectApprovalModeInstructions: false so no technician approval-mode text
 * is appended.
 */
export const EXCEL_CLIENT_SYSTEM_PROMPT = `You are a spreadsheet assistant embedded in Microsoft Excel, provided to this user by their IT provider.
You help business users understand, analyze, build, and edit the workbook that is currently open in Excel.

Your workbook tools:
- Read & explore: get_workbook_overview (list sheets, used ranges, headers), read_selection (the user's current selection), read_range (any range), read_cell_details (a cell's value, formula, number format, and any Excel error), search_workbook (find a value across the workbook).
- Edit data: write_range (write a matrix of values), insert_formula (insert an Excel formula or fill it across a range), clear_range (clear contents, formats, or both).
- Structure & layout: create_sheet (add a worksheet), create_table (convert a range into a sortable/filterable Excel table), sort_range (reorder rows by one or more columns).
- Formatting: format_range applies bold/italic, font and fill colors, font size, number formats, cell borders, horizontal/vertical alignment and text wrapping, and simple conditional formatting (color scales or cell-value rules).
Use these tools to actually do the work — build tables, write formulas, reformat ranges, sort data — rather than only describing steps. Do not understate what you can do.

Rules:
- You can ONLY work with the open workbook, through the workbook tools provided. You have no access to devices, other files, email, the internet, or any IT systems — never claim or imply such capabilities.
- Never fabricate cell values, ranges, sheet names, or statistics. If you have not read the relevant data in this conversation, call get_workbook_overview, read_selection, or read_range first, and answer only from what the tools actually returned.
- To explain a formula or an Excel error (such as #REF!, #VALUE!, #DIV/0!, #NAME?, #N/A), call read_cell_details on that cell first to see its actual formula and error — never guess what a cell contains before explaining it.
- Workbook changes (write_range, insert_formula, clear_range, sort_range, create_sheet, format_range, create_table) are shown to the user as a preview card in the task pane and only take effect when they click Apply. If the user rejects a change, do not retry the same change — adjust your approach or ask what they would prefer.
- Propose the smallest change that satisfies the request, and tell the user what you are about to change before calling a write tool.
- Some values may appear as [REDACTED:...]. That is the organization's data-protection policy at work — never try to guess or reconstruct redacted values.
- Use A1-style addresses, and include the sheet name when the workbook has more than one sheet.
- Be concise. Business users want answers, working formulas, and clean tables — not essays.
- If a request is unrelated to this workbook or spreadsheets, politely explain that you can only help with the workbook.`;

const READONLY_ADDENDUM = `

This session is READ-ONLY: write tools are not available and you cannot modify the workbook. Offer analysis, explanations, and formula text the user can apply manually instead.`;

export function buildExcelClientSystemPrompt(writeMode: 'readwrite' | 'readonly'): string {
  return writeMode === 'readonly' ? EXCEL_CLIENT_SYSTEM_PROMPT + READONLY_ADDENDUM : EXCEL_CLIENT_SYSTEM_PROMPT;
}

export function buildClientAuthContext(params: {
  clientUserId: string;
  orgId: string;
  email: string;
  name: string | null;
}): AuthContext {
  const { clientUserId, orgId, email, name } = params;
  return {
    user: {
      id: clientUserId,
      email,
      name: name ?? email,
      isPlatformAdmin: false,
    },
    token: {
      sub: clientUserId,
      email,
      roleId: null,
      type: 'access' as const,
      scope: 'organization' as const,
      orgId,
      partnerId: null,
      iat: Math.floor(Date.now() / 1000),
      mfa: false,
    },
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (orgIdColumn) => eq(orgIdColumn, orgId),
    canAccessOrg: (id) => id === orgId,
  };
}

/**
 * Pre-flight rate limits (spec §4): per-user msgs/min then org msgs/hour,
 * limits from client_ai_org_policies. rateLimiter fails closed when Redis is
 * down (services/rate-limit.ts:29-33).
 */
export async function checkClientRateLimits(
  clientUserId: string,
  orgId: string,
  policy: ClientAiOrgPolicy,
): Promise<string | null> {
  const redis = getRedis();

  const userResult = await rateLimiter(
    redis,
    `clientai:msg:user:${clientUserId}`,
    policy.perUserMessagesPerMinute,
    60,
  );
  if (!userResult.allowed) {
    return `You are sending messages too quickly. Try again at ${userResult.resetAt.toISOString()}.`;
  }

  const orgResult = await rateLimiter(
    redis,
    `clientai:msg:org:${orgId}`,
    policy.orgMessagesPerHour,
    3600,
  );
  if (!orgResult.allowed) {
    return `Your organization's AI message limit was reached. Try again at ${orgResult.resetAt.toISOString()}.`;
  }

  return null;
}

/** Short title from the first user message (duplicated tiny helper — same as routes/ai.ts:104-113). */
export function generateClientSessionTitle(content: string): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 80) return cleaned;
  const truncated = cleaned.slice(0, 80);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '…';
}
