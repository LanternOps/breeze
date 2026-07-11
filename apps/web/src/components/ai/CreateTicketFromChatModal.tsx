import { useId, useState } from "react";

import type { AiTicketDraft } from "@breeze/shared";

import { Dialog } from "../shared/Dialog";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

const BTN =
  "inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50";

const INPUT =
  "mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary";

export interface CreateTicketFromChatModalProps {
  draft: AiTicketDraft | null;
  orgName: string | null;
  deviceHostname: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: {
    subject: string;
    description: string;
    status: "open" | "resolved";
    resolutionNote?: string;
    timeMinutes: number;
    billable: boolean;
  }) => void;
}

export default function CreateTicketFromChatModal({
  draft,
  orgName,
  deviceHostname,
  busy,
  onCancel,
  onSubmit,
}: CreateTicketFromChatModalProps) {
  const { t } = useTranslation("ai");
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [description, setDescription] = useState(draft?.problemSummary ?? "");
  const [resolutionNote, setResolutionNote] = useState(
    draft?.resolutionSummary ?? "",
  );
  const [status, setStatus] = useState<"open" | "resolved">(
    draft?.suggestedStatus ?? "open",
  );
  const [timeMinutes, setTimeMinutes] = useState(
    String(draft?.suggestedTimeMinutes ?? 0),
  );
  const [billable, setBillable] = useState(true);
  const titleId = useId();

  const resolutionMissing =
    status === "resolved" && resolutionNote.trim().length === 0;
  const canSubmit = !busy && subject.trim().length > 0 && !resolutionMissing;

  const submit = () => {
    if (!canSubmit) return;

    onSubmit({
      subject: subject.trim(),
      description: description.trim(),
      status,
      resolutionNote: status === "resolved" ? resolutionNote.trim() : undefined,
      timeMinutes: Math.max(0, Number.parseInt(timeMinutes, 10) || 0),
      billable,
    });
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onCancel();
      }}
      title={t("createTicketFromChatModal.title")}
      labelledBy={titleId}
      maxWidth="md"
      className="p-5"
    >
      <div data-testid="create-ticket-from-chat-modal">
        <h3 id={titleId} className="text-base font-semibold">
          {t("createTicketFromChatModal.title")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {orgName ?? draft?.orgName ?? t("common:labels.organization")}
          {(deviceHostname ?? draft?.deviceHostname)
            ? ` - ${deviceHostname ?? draft?.deviceHostname}`
            : ""}
        </p>

        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("createTicketFromChatModal.subject")}
            </span>
            <input
              aria-label={t("createTicketFromChatModal.subject")}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={255}
              className={INPUT}
            />
          </label>

          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("createTicketFromChatModal.problem")}
            </span>
            <textarea
              aria-label={t("createTicketFromChatModal.problem")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className={INPUT}
            />
          </label>

          <fieldset>
            <legend className="text-sm text-muted-foreground">
              {t("common:labels.status")}
            </legend>
            <div className="mt-1 flex gap-4">
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="create-ticket-status"
                  checked={status === "open"}
                  onChange={() => setStatus("open")}
                />
                {t("createTicketFromChatModal.open")}
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="create-ticket-status"
                  checked={status === "resolved"}
                  onChange={() => setStatus("resolved")}
                />
                {t("createTicketFromChatModal.resolved")}
              </label>
            </div>
          </fieldset>

          {status === "resolved" && (
            <label className="block text-sm">
              <span className="text-muted-foreground">
                {t("createTicketFromChatModal.resolution")}
              </span>
              <textarea
                aria-label={t("createTicketFromChatModal.resolution")}
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                rows={3}
                className={INPUT}
              />
              {resolutionMissing && (
                <span className="mt-1 block text-xs text-red-500">
                  {t("createTicketFromChatModal.resolutionRequired")}
                </span>
              )}
            </label>
          )}

          <div className="flex items-center gap-4">
            <label className="block text-sm">
              <span className="text-muted-foreground">
                {t("createTicketFromChatModal.timeMinutes")}
              </span>
              <input
                aria-label={t("createTicketFromChatModal.timeMinutesAria")}
                type="number"
                min={0}
                value={timeMinutes}
                onChange={(e) => setTimeMinutes(e.target.value)}
                className={`${INPUT} w-24`}
              />
            </label>
            <label className="mt-6 inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={billable}
                onChange={(e) => setBillable(e.target.checked)}
              />
              {t("createTicketFromChatModal.billable")}
            </label>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className={`${BTN} hover:bg-muted`}
            onClick={onCancel}
            disabled={busy}
          >
            {t("common:actions.cancel")}
          </button>
          <button
            type="button"
            className={`${BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={!canSubmit}
            onClick={submit}
          >
            {t("createTicketFromChatModal.createTicket")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
