import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Braces, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BUILTIN_INSTALLER_VARIABLES,
  customFieldToken,
  findUnknownTokens,
  type InstallerVariable,
  type InstallerVariableGroup,
} from "@/lib/installerVariables";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
export interface DeviceCustomField {
  fieldKey: string;
  name: string;
}
interface VariableInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Device custom-field definitions, offered under "Custom fields" in the menu. */
  customFields?: DeviceCustomField[];
  /** Applied as the input's `id` so a parent `<label htmlFor>` can associate a visible label. */
  id?: string;
  "aria-describedby"?: string;
  className?: string;
}
const GROUP_ORDER: InstallerVariableGroup[] = [
  "Organization",
  "Site",
  "Device",
  "Custom fields",
];
/**
 * A single-line text input for installer URLs / silent args that accepts
 * `{{...}}` deploy-time variables. Adds an "Insert variable" menu (rendered in a
 * portal with fixed positioning so it never clips inside a scrollable modal) and
 * a live warning when the string contains a token the resolver won't recognize.
 */
export default function VariableInput({
  value,
  onChange,
  placeholder,
  customFields = [],
  id,
  className,
  "aria-describedby": ariaDescribedBy,
}: VariableInputProps) {
  useTranslation("policies");
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    width: number;
  }>();
  const warnId = useId();
  const knownKeys = useMemo(
    () => new Set(customFields.map((f) => f.fieldKey)),
    [customFields],
  );
  const variables = useMemo<InstallerVariable[]>(() => {
    const custom: InstallerVariable[] = customFields.map((f) => ({
      token: customFieldToken(f.fieldKey),
      label: f.name || f.fieldKey,
      group: "Custom fields",
      example: f.fieldKey,
    }));
    return [...BUILTIN_INSTALLER_VARIABLES, ...custom];
  }, [customFields]);
  const grouped = useMemo(() => {
    const map = new Map<InstallerVariableGroup, InstallerVariable[]>();
    for (const v of variables) {
      const list = map.get(v.group) ?? [];
      list.push(v);
      map.set(v.group, list);
    }
    return GROUP_ORDER.map((g) => [g, map.get(g) ?? []] as const).filter(
      ([, l]) => l.length > 0,
    );
  }, [variables]);
  // Custom-field keys load async; until they arrive, accept custom-field tokens
  // on structure alone so a slow fetch never flags a valid `{{device.customField.x}}`.
  const unknownTokens = useMemo(
    () =>
      findUnknownTokens(value, knownKeys, {
        requireKnownCustomKeys: knownKeys.size > 0,
      }),
    [value, knownKeys],
  );
  const positionMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 288;
    // Right-align the menu to the trigger, clamped to the viewport.
    const left = Math.max(
      8,
      Math.min(rect.right - width, window.innerWidth - width - 8),
    );
    setCoords({ top: rect.bottom + 4, left, width });
  };
  useLayoutEffect(() => {
    if (open) positionMenu();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onScroll = () => positionMenu();
    const onPointer = (e: PointerEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const insert = (token: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    setOpen(false);
    // Restore focus + place caret after the inserted token.
    requestAnimationFrame(() => {
      el?.focus();
      const caret = start + token.length;
      el?.setSelectionRange(caret, caret);
    });
  };
  return (
    <div className="relative">
      <div className="flex items-stretch gap-2">
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={unknownTokens.length > 0 || undefined}
          aria-describedby={
            cn(ariaDescribedBy, unknownTokens.length > 0 && warnId) || undefined
          }
          className={cn(
            "h-10 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring",
            unknownTokens.length > 0 &&
              "border-destructive/60 focus:ring-destructive/40",
            className,
          )}
        />
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={i18n.t(
            "policies:software.variableInput.insertADeployTimeVariable",
          )}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium text-muted-foreground hover:bg-muted focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <Braces className="h-4 w-4" />
          <span className="hidden sm:inline">
            {i18n.t("policies:software.variableInput.insertVariable")}
          </span>
        </button>
      </div>

      {unknownTokens.length > 0 && (
        <p
          id={warnId}
          className="mt-1 flex items-start gap-1.5 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {i18n.t("policies:software.variableInput.unknownVariable")}
            {unknownTokens.join(", ")}
            {i18n.t(
              "policies:software.variableInput.pickOneFromInsertVariable",
            )}
          </span>
        </p>
      )}

      {open &&
        coords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-[60] max-h-80 overflow-y-auto rounded-md border bg-card p-1 shadow-lg"
            style={{ top: coords.top, left: coords.left, width: coords.width }}
          >
            {grouped.map(([group, list]) => (
              <div key={group} className="py-1">
                <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group}
                </p>
                {list.map((v) => (
                  <button
                    key={v.token}
                    type="button"
                    role="menuitem"
                    onClick={() => insert(v.token)}
                    className="flex w-full items-baseline justify-between gap-3 rounded px-2 py-1.5 text-left hover:bg-muted focus:bg-muted focus:outline-hidden"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-foreground">
                        {v.label}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {v.token}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
