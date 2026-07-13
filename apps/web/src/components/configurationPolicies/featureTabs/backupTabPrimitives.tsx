// Shared form primitives for the Backup feature tab family
// (BackupTab.tsx + BackupDestinationSection.tsx + the Backup Profiles editor).

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { i18n } from "@/lib/i18n";

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full border transition focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${checked ? "bg-emerald-500/80" : "bg-muted"}`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white transition ${checked ? "translate-x-5" : "translate-x-1"}`}
        />
      </button>
    </div>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-destructive">{message}</p>;
}

export function PathList({
  items,
  onAdd,
  onRemove,
  placeholder,
  emptyLabel,
  pendingValue,
  onPendingChange,
}: {
  items: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  placeholder: string;
  emptyLabel: string;
  /** Optional controlled pending input so the parent can flush a typed-but-not-added value on save. */
  pendingValue?: string;
  onPendingChange?: (value: string) => void;
}) {
  const [localInput, setLocalInput] = useState("");
  const input = pendingValue ?? localInput;
  const setInput = onPendingChange ?? setLocalInput;
  const handleAdd = () => {
    const trimmed = input.trim();
    if (!trimmed || items.includes(trimmed)) return;
    onAdd(trimmed);
    setInput("");
  };
  return (
    <div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && (e.preventDefault(), handleAdd())
          }
          placeholder={placeholder}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" />
          {i18n.t("common:actions.add")}
        </button>
      </div>
      {items.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {items.map((item) => (
            <div
              key={item}
              className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-1.5 text-sm"
            >
              <span className="truncate font-mono text-xs">{item}</span>
              <button
                type="button"
                onClick={() => onRemove(item)}
                aria-label={i18n.t("common:actions.remove")}
                className="ml-2 rounded p-1 hover:bg-muted"
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          ))}
        </div>
      )}
      {items.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  );
}
