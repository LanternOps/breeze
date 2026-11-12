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
/** Provenance ids a standing-instruction block carries; not what the approver is reading for. */
const MEMORY_PROVENANCE_KEYS = new Set(["instructionId", "sourceMessageId", "captureId"]);

/**
 * Who a public reply emails. The notify worker sends a customer reply to
 * `tickets.submitter_email` only (ticketNotifyWorker.ts), so a requester name
 * without an email reaches nobody and is not offered as a recipient.
 */
function formatRecipient(ctx: AiApprovalTicketContext): string | null {
  const email = ctx.requesterEmail?.trim();
  if (!email) return null;
  const name = ctx.requesterName?.trim();
  return name ? `${name} <${email}>` : email;
}

export interface MemoryPreview {
  /** `content.text`, the canonical field (standing instructions, `wispStandingInstruction.ts`). */
  text: string | null;
  /** Every other scalar field, as `key: value` lines — for a standing instruction these shape the rule. */
  fields: string[];
  /** Something (a nested value) is not shown here and is only under the raw parameters. */
  omitted: boolean;
}

/** What a memory block will hold, split for the card. Provenance ids are left out. */
export function memoryPreview(content: unknown): MemoryPreview {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return { text: null, fields: [], omitted: content !== undefined && content !== null };
  }
  const record = content as Record<string, unknown>;
  const text = typeof record.text === "string" && record.text.trim() ? record.text : null;
  const fields: string[] = [];
  let omitted = false;
  for (const [key, value] of Object.entries(record)) {
    if ((key === "text" && text !== null) || MEMORY_PROVENANCE_KEYS.has(key) || value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
      if (value.length > 0) fields.push(`${key}: ${value.join(", ")}`);
    } else {
      omitted = true;
    }
  }
  return { text, fields, omitted };
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
  const recipient = ticketContext ? formatRecipient(ticketContext) : null;
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
              : ticketContext
                ? t("aiApprovalDialog.ticketComment.publicNoEmail")
                // The ticket could not be read: say what the headline says.
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
  const { text, fields, omitted } = memoryPreview(input.content);
  const ownerKind = typeof input.ownerKind === "string" && MEMORY_SCOPES.has(input.ownerKind) ? input.ownerKind : null;
  const blockType = typeof input.blockType === "string" ? input.blockType : null;
  const subjectKey = typeof input.subjectKey === "string" && input.subjectKey.trim() ? input.subjectKey : null;
  if (!text && fields.length === 0 && !ownerKind && !blockType && !subjectKey) return null;
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
      {fields.length > 0 && (
        <div
          data-testid="approval-memory-fields"
          className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-gray-700 dark:text-gray-300"
        >
          {fields.join("\n")}
        </div>
      )}
      {subjectKey && (
        <div data-testid="approval-memory-key" className="mt-1.5 break-words text-[11px] text-gray-500 dark:text-gray-400">
          {t("aiApprovalDialog.memory.subjectKey", { key: subjectKey })}
        </div>
      )}
      {omitted && (
        <div data-testid="approval-memory-more" className="mt-1 text-[11px] italic text-gray-500 dark:text-gray-400">
          {t("aiApprovalDialog.memory.moreInParameters")}
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
