import { Brain, Mail, StickyNote, Ticket } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AiApprovalTicketContext } from "@breeze/shared";

/**
 * #11674: the part of an approval card that says WHAT is being approved.
 *
 * The headline (`description`) is built from tool input alone and, by design,
 * never carries ticket or memory content (it also feeds the push and the
 * audit label). Before this, the words a customer would receive — or the rule
 * Wisp would remember — were reachable only under the collapsed "Show
 * parameters", as JSON with `\n` escapes. These rows put them on the card,
 * always visible, as plain text with real line breaks. Rendered as React text
 * nodes only: the content is model- or customer-authored and is never parsed
 * as markup.
 */

const MEMORY_SCOPES = new Set(["user", "org", "partner"]);
/** Internal ids a standing-instruction block carries; not what the approver is reading for. */
const MEMORY_ID_KEYS = new Set(["instructionId", "sourceMessageId", "captureId", "deviceId"]);

function formatRecipient(ctx: AiApprovalTicketContext | undefined): string | null {
  if (!ctx) return null;
  const name = ctx.requesterName?.trim();
  const email = ctx.requesterEmail?.trim();
  if (name && email) return `${name} <${email}>`;
  return name || email || null;
}

/**
 * The text a memory block will hold. `content.text` is the canonical field
 * (standing instructions, `wispStandingInstruction.ts`); any other block shape
 * falls back to its scalar fields as `key: value` lines. Nested values stay in
 * the raw parameters below the card.
 */
export function memoryText(content: unknown): string | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const record = content as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.trim()) return record.text;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (MEMORY_ID_KEYS.has(key) || value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" || typeof v === "number")) {
      lines.push(`${key}: ${value.join(", ")}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function TicketContextRow({ ctx }: { ctx: AiApprovalTicketContext }) {
  return (
    <div
      data-testid="approval-ticket-context"
      className="mt-2 flex items-center gap-2 rounded-md bg-gray-100/60 px-2.5 py-1.5 text-xs dark:bg-gray-800/60"
    >
      <Ticket className="h-3.5 w-3.5 shrink-0 text-gray-400" />
      <span className="shrink-0 font-medium text-gray-900 dark:text-gray-200">{ctx.ticketNumber}</span>
      <span className="text-gray-600">&middot;</span>
      <span className="truncate text-gray-700 dark:text-gray-300">{ctx.subject}</span>
    </div>
  );
}

function TicketCommentPreview({
  isPublic,
  content,
  ticketContext,
}: {
  isPublic: boolean;
  content: string;
  ticketContext?: AiApprovalTicketContext;
}) {
  const { t } = useTranslation("ai");
  const recipient = formatRecipient(ticketContext);
  return (
    <div className="mt-2 rounded-md border border-border bg-background/60 px-2.5 py-2 text-xs">
      <div
        data-testid="approval-ticket-comment-recipient"
        className={
          isPublic
            ? "flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300"
            : "flex items-center gap-1.5 font-medium text-gray-600 dark:text-gray-300"
        }
      >
        {isPublic ? <Mail className="h-3.5 w-3.5 shrink-0" /> : <StickyNote className="h-3.5 w-3.5 shrink-0" />}
        <span>
          {isPublic
            ? recipient
              ? t("aiApprovalDialog.ticketComment.publicTo", { recipient })
              : t("aiApprovalDialog.ticketComment.publicNoRecipient")
            : t("aiApprovalDialog.ticketComment.internal")}
        </span>
      </div>
      <div
        data-testid="approval-ticket-comment-message"
        className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm text-gray-900 dark:text-gray-100"
      >
        {content}
      </div>
    </div>
  );
}

function MemoryWritePreview({ input }: { input: Record<string, unknown> }) {
  const { t } = useTranslation("ai");
  const text = memoryText(input.content);
  const ownerKind = typeof input.ownerKind === "string" && MEMORY_SCOPES.has(input.ownerKind) ? input.ownerKind : null;
  const blockType = typeof input.blockType === "string" ? input.blockType : null;
  if (!text && !ownerKind && !blockType) return null;
  return (
    <div data-testid="approval-memory-preview" className="mt-2 rounded-md border border-border bg-background/60 px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-medium text-gray-700 dark:text-gray-300">
        <Brain className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span>{t("aiApprovalDialog.memory.heading")}</span>
        {blockType && (
          <>
            <span className="text-gray-500">&middot;</span>
            <span>
              {t(/* i18n-dynamic */ `aiApprovalDialog.memory.types.${blockType}`, { defaultValue: blockType })}
            </span>
          </>
        )}
        {ownerKind && (
          <>
            <span className="text-gray-500">&middot;</span>
            <span>{t(/* i18n-dynamic */ `aiApprovalDialog.memory.scope.${ownerKind}`)}</span>
          </>
        )}
      </div>
      {text && (
        <div
          data-testid="approval-memory-text"
          className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm text-gray-900 dark:text-gray-100"
        >
          {text}
        </div>
      )}
    </div>
  );
}

export default function ApprovalContentPreview({
  toolName,
  input,
  ticketContext,
}: {
  toolName: string;
  input: Record<string, unknown>;
  ticketContext?: AiApprovalTicketContext;
}) {
  if (toolName === "remember") return <MemoryWritePreview input={input} />;
  if (toolName !== "manage_tickets") return null;
  const isComment = input.action === "comment" && typeof input.content === "string" && input.content.length > 0;
  return (
    <>
      {ticketContext && <TicketContextRow ctx={ticketContext} />}
      {isComment && (
        <TicketCommentPreview
          // Same predicate as the guardrail headline and the tier (`isPublic === true`).
          isPublic={input.isPublic === true}
          content={input.content as string}
          ticketContext={ticketContext}
        />
      )}
    </>
  );
}
