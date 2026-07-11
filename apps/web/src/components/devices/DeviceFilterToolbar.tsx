// DeviceFilterToolbar — the single, unified filter surface for the Devices
// page, in the chip-centric model. EVERY structured filter is an editable chip
// living in one server-resolved FilterConditionGroup; the only standing inline
// control is the device Search box.
//
// Layout (one control row):
//   🔍 Search · quick-preset chips · More ▾ (add any chip type) · Advanced ▾
// Then an active editable-chip row (shown when the group has chips), each chip
// click-to-edit (operator/value popover) and ✕-to-remove, with a Clear that
// resets the group to null AND clears search.
//
// State routing:
//  - search → listFilters.search (instant client filter, owned by DevicesPage,
//    consumed by DeviceList).
//  - everything else → the FilterConditionGroup (`value`/`onChange`), resolved
//    server-side upstream via useAdvancedFilterIds. Status/OS/Role/Org/Site/
//    Group are NO LONGER inline client state — they are group conditions/chips.
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Check, Plus, SlidersHorizontal } from "lucide-react";
import type { FilterCondition, FilterConditionGroup } from "@breeze/shared";
import { type NamedRef } from "./FilterValueEditor";
import { FilterSentenceBuilder } from "./FilterSentenceBuilder";
import { FilterAddDropdown } from "./FilterAddDropdown";
import { Chip, defaultConditionForField } from "./FilterChipBar";
import { QUICK_ADD_CHIPS } from "./QuickAddChips";
import { SavedViewsMenu } from "./SavedViewsMenu";
import type { ListFilters } from "./deviceListFilters";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

type Org = { id: string; name: string };
type Site = { id: string; name: string };
type Group = {
  id: string;
  name: string;
  type: "static" | "dynamic";
  deviceCount: number;
};

export interface DeviceFilterToolbarProps {
  // The server-resolved group (quick chips + More-added chips + Advanced drawer).
  value: FilterConditionGroup | null;
  onChange: (next: FilterConditionGroup | null) => void;
  // Instant client-side filter (device search only), owned by DevicesPage and
  // shared with DeviceList.
  listFilters: ListFilters;
  onListFiltersChange: (next: ListFilters) => void;
  orgs?: Org[];
  sites?: Site[];
  groups?: Group[];
  softwareOptions?: string[];
  onSoftwareSearch?: (q: string) => void;
  // Opens the create-group flow (CreateGroupModal in DevicesPage); surfaced as a
  // "+ New group…" shortcut in the Add-filter picker.
  onCreateGroup?: () => void;
}

const EMPTY_GROUP: FilterConditionGroup = { operator: "AND", conditions: [] };

function chipMatches(c: FilterCondition, target: FilterCondition): boolean {
  return (
    c.field === target.field &&
    c.operator === target.operator &&
    JSON.stringify(c.value) === JSON.stringify(target.value)
  );
}

function groupHasCondition(
  group: FilterConditionGroup | null,
  target: FilterCondition,
): boolean {
  if (!group) return false;
  for (const c of group.conditions) {
    if ("conditions" in c) continue;
    if (chipMatches(c, target)) return true;
  }
  return false;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The values currently selected for `field` via `equals`/`in` conditions. Two
// `equals` on the same field would AND to empty (a device can't be both online
// AND offline), so we model multi-select as ONE condition — OR within a field,
// AND across fields. This reads them back out for toggling/active state.
function fieldEqualsValues(
  group: FilterConditionGroup | null,
  field: string,
): unknown[] {
  const vals: unknown[] = [];
  for (const c of group?.conditions ?? []) {
    if ("conditions" in c) continue;
    if (c.field !== field) continue;
    if (c.operator === "equals") vals.push(c.value);
    else if (c.operator === "in" && Array.isArray(c.value))
      vals.push(...c.value);
  }
  return vals;
}

// Replace every equals/in condition on `field` with one normalized condition for
// `values` (none → drop the field; 1 → `equals`; >1 → `in`). The merged chip
// takes the slot of the first replaced condition so chip order stays stable;
// other fields and non-equals/in conditions on this field are left untouched.
function setFieldEqualsValues(
  group: FilterConditionGroup | null,
  field: string,
  values: unknown[],
): FilterConditionGroup | null {
  const base = group ?? EMPTY_GROUP;
  const merged: FilterCondition | null =
    values.length === 0
      ? null
      : values.length === 1
        ? ({ field, operator: "equals", value: values[0] } as FilterCondition)
        : ({ field, operator: "in", value: values } as FilterCondition);
  let placed = false;
  const next: FilterConditionGroup["conditions"] = [];
  for (const c of base.conditions) {
    const isTargetEnum =
      !("conditions" in c) &&
      c.field === field &&
      (c.operator === "equals" || c.operator === "in");
    if (isTargetEnum) {
      if (merged && !placed) {
        next.push(merged);
        placed = true;
      }
      continue;
    }
    next.push(c);
  }
  if (merged && !placed) next.push(merged);
  return next.length === 0 ? null : { operator: "AND", conditions: next };
}

// Top-level chip conditions, with their absolute index in group.conditions so
// edit/remove can target the right element even when nested groups (which only
// the Advanced drawer can create) are interleaved.
function topLevelConditions(
  group: FilterConditionGroup | null,
): Array<{ condition: FilterCondition; index: number }> {
  if (!group) return [];
  const out: Array<{ condition: FilterCondition; index: number }> = [];
  group.conditions.forEach((c, index) => {
    if (!("conditions" in c)) out.push({ condition: c, index });
  });
  return out;
}

// A value that actually constrains the query — blank text / empty array are
// "incomplete" (a half-built Advanced-drawer row) and must NOT trigger merging,
// or the drawer can't hold two in-progress rows on the same default field.
function isConcrete(v: unknown): boolean {
  if (v === "" || v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// Collapse same-field `equals`/`in` conditions at the top level of an AND group
// into ONE `in` condition (OR within a field). This is the single chokepoint
// that makes a self-contradictory status filter (status=online AND
// status=offline → always empty) structurally impossible, no matter which entry
// point produced it: presets, the More picker, the chip editor, or the Advanced
// drawer. Only fires for a field that has TWO OR MORE concrete equals/in values
// — so a power user can still add blank/in-progress rows in the Advanced drawer,
// and range filters (gt/lt, different operators) are never touched. OR / nested
// groups (operator !== 'AND') are left untouched so a deliberately-built
// advanced sentence keeps its meaning.
function normalizeGroup(
  group: FilterConditionGroup | null,
): FilterConditionGroup | null {
  if (!group || group.operator !== "AND") return group;
  const concreteCount = new Map<string, number>();
  for (const c of group.conditions) {
    if ("conditions" in c) continue;
    if (
      (c.operator === "equals" || c.operator === "in") &&
      isConcrete(c.value)
    ) {
      concreteCount.set(c.field, (concreteCount.get(c.field) ?? 0) + 1);
    }
  }
  let acc: FilterConditionGroup | null = group;
  for (const [field, count] of concreteCount) {
    if (count < 2) continue; // single value (plus any blank rows) → leave as-is
    const vals: unknown[] = [];
    for (const v of fieldEqualsValues(acc, field)) {
      if (isConcrete(v) && !vals.some((x) => sameValue(x, v))) vals.push(v);
    }
    acc = setFieldEqualsValues(acc, field, vals);
  }
  return acc;
}

export function DeviceFilterToolbar({
  value,
  onChange: rawOnChange,
  listFilters,
  onListFiltersChange,
  orgs = [],
  sites = [],
  groups: _groups = [],
  softwareOptions,
  onSoftwareSearch,
  onCreateGroup,
}: DeviceFilterToolbarProps) {
  const { t } = useTranslation("devices");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Scroll-edge state for the chip row: with the scrollbar hidden, a right/left
  // gradient is the only cue that more chips exist off-screen. Recomputed on
  // scroll + resize.
  const chipsRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const el = chipsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  }, []);
  useEffect(() => {
    updateEdges();
    const el = chipsRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateEdges, { passive: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(updateEdges);
      ro.observe(el);
    }
    window.addEventListener("resize", updateEdges);
    return () => {
      el.removeEventListener("scroll", updateEdges);
      ro?.disconnect();
      window.removeEventListener("resize", updateEdges);
    };
  }, [updateEdges]);

  // Every group mutation flows through here so the merge invariant holds for all
  // entry points (preset toggle already produces merged output; chip edit and
  // the Advanced drawer would not without this).
  const onChange = (next: FilterConditionGroup | null) =>
    rawOnChange(normalizeGroup(next));

  const patch = (next: Partial<ListFilters>) =>
    onListFiltersChange({ ...listFilters, ...next });

  // --- GROUP helpers (all structured filters live here) ---
  const addCondition = (cond: FilterCondition) => {
    // An `equals` value is single-select per field: a device has exactly one
    // status / OS / role, so picking a value REPLACES any existing value for
    // that field (mirrors the old single-select dropdowns). This also makes a
    // contradictory status=online AND status=offline impossible by construction.
    if (cond.operator === "equals") {
      onChange(setFieldEqualsValues(value, cond.field, [cond.value]));
      return;
    }
    const base = value ?? EMPTY_GROUP;
    onChange({ operator: "AND", conditions: [...base.conditions, cond] });
  };
  const removeConditionAt = (index: number) => {
    if (!value) return;
    const next = value.conditions.filter((_, i) => i !== index);
    onChange(next.length === 0 ? null : { operator: "AND", conditions: next });
  };
  const updateConditionAt = (index: number, cond: FilterCondition) => {
    if (!value) return;
    const next = value.conditions.map((c, i) => (i === index ? cond : c));
    onChange({ operator: "AND", conditions: next });
  };
  const toggleCondition = (cond: FilterCondition) => {
    if (groupHasCondition(value, cond)) {
      const idx = value!.conditions.findIndex(
        (c) => !("conditions" in c) && chipMatches(c, cond),
      );
      if (idx !== -1) removeConditionAt(idx);
    } else {
      addCondition(cond);
    }
  };

  // A preset is active when its value is currently selected for the field
  // (stored as `equals`, or part of an `in` built in the Advanced drawer).
  // Non-equals presets (greaterThan / isEmpty / boolean) match exactly.
  const presetActive = (cond: FilterCondition): boolean =>
    cond.operator === "equals"
      ? fieldEqualsValues(value, cond.field).some((v) =>
          sameValue(v, cond.value),
        )
      : groupHasCondition(value, cond);

  // `equals` presets are single-select within their field: clicking Offline
  // while Online is active SWITCHES to Offline (online/offline are mutually
  // exclusive, like the old status dropdown). Clicking the already-active value
  // clears it. Other operators (greaterThan / isEmpty / boolean) toggle on/off.
  const togglePreset = (cond: FilterCondition) => {
    if (cond.operator !== "equals") {
      toggleCondition(cond);
      return;
    }
    const current = fieldEqualsValues(value, cond.field);
    const isSoleActive =
      current.length === 1 && sameValue(current[0], cond.value);
    onChange(
      setFieldEqualsValues(value, cond.field, isSoleActive ? [] : [cond.value]),
    );
  };

  const activeConditions = topLevelConditions(value);
  const hasSearch = listFilters.search.trim().length > 0;
  const hasChips = activeConditions.length > 0;
  const hasAnyActive = hasChips || hasSearch;

  const clearAll = () => {
    onListFiltersChange({ ...listFilters, search: "" });
    onChange(null);
  };

  return (
    <div data-testid="device-filter-toolbar" className="flex flex-col gap-2">
      {/* Unified filter bar — one surface holding the live device search, the
          quick-preset chips, and the "+ Add filter" picker. The bar itself owns
          the border + focus ring; everything inside is borderless/chip-light so
          the controls read as one cohesive tool, not three stacked widgets. */}
      <div className="flex items-center gap-2 rounded-lg border bg-background px-2 py-1.5 transition focus-within:ring-2 focus-within:ring-ring">
        {/* Device search — borderless, blends into the bar (the one live filter). */}
        <div className="flex w-40 shrink-0 items-center gap-2 sm:w-56">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            placeholder={t("deviceFilterToolbar.searchDevices")}
            aria-label={t("deviceFilterToolbar.searchDevices")}
            value={listFilters.search}
            onChange={(e) => patch({ search: e.target.value })}
            className="w-full appearance-none border-0 bg-transparent p-0 text-sm placeholder:text-muted-foreground focus:outline-hidden focus:ring-0"
          />
        </div>

        {/* Divider between the live search and the chip controls. */}
        <div className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* Quick-preset chips — scroll horizontally if they outgrow the row.
            The scrollbar is hidden, so left/right gradient fades are the cue
            that more chips exist off-screen. */}
        <div className="relative flex min-w-0 flex-1 items-center">
          <div
            ref={chipsRef}
            data-testid="quick-add-chips"
            className="no-scrollbar flex w-full items-center gap-1.5 overflow-x-auto"
            role="group"
            aria-label={t("deviceFilterToolbar.quickFilters")}
          >
            {QUICK_ADD_CHIPS.map((chip) => {
              const active = presetActive(chip.condition);
              return (
                <button
                  type="button"
                  key={chip.id}
                  data-testid={`quick-add-${chip.id}`}
                  aria-pressed={active}
                  onClick={() => togglePreset(chip.condition)}
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    active
                      ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                      : "hover:bg-muted"
                  }`}
                >
                  {active && <Check className="h-3 w-3" />}
                  {chip.label}
                </button>
              );
            })}
          </div>
          {edges.left && (
            <div
              className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-linear-to-r from-background to-transparent"
              aria-hidden="true"
            />
          )}
          {edges.right && (
            <div
              className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-linear-to-l from-background to-transparent"
              aria-hidden="true"
            />
          )}
        </div>

        {/* + Add filter — the field-type picker, chip-styled so it reads as part
            of the chip row. Kept OUTSIDE the scroll group so its dropdown isn't
            clipped, and so it stays pinned/reachable as presets scroll. */}
        <FilterAddDropdown
          align="right"
          onCreateGroup={onCreateGroup}
          onSelect={(field) => addCondition(defaultConditionForField(field))}
          renderTrigger={({ open, toggle }) => (
            <button
              type="button"
              data-testid="filter-more-button"
              aria-haspopup="true"
              aria-expanded={open}
              onClick={toggle}
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed px-2.5 py-0.5 text-xs transition-colors hover:border-solid hover:bg-muted hover:text-foreground ${
                open
                  ? "border-solid bg-muted text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              <Plus className="h-3 w-3" />
              {t("deviceFilterToolbar.addFilter")}{" "}
            </button>
          )}
        />

        {/* Views — save/recall named filter templates (its own ghost menu so
            recall stays separate from building chips). */}
        <SavedViewsMenu value={value} onApply={onChange} />

        {/* Advanced — de-emphasized ghost toggle; opens the boolean sentence
            builder for power users. */}
        <button
          type="button"
          data-testid="filter-advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((o) => !o)}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
            advancedOpen
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t("deviceFilterToolbar.advanced")}{" "}
        </button>
      </div>

      {/* Active editable-chip row — only when the group has chips. */}
      {hasChips && (
        <div
          data-testid="active-filter-chips"
          className="flex flex-wrap items-center gap-2"
        >
          {activeConditions.map(({ condition, index }) => (
            <Chip
              key={index}
              condition={condition}
              onChange={(next) => updateConditionAt(index, next)}
              onRemove={() => removeConditionAt(index)}
              orgs={orgs as NamedRef[]}
              sites={sites as NamedRef[]}
              softwareOptions={softwareOptions}
              onSoftwareSearch={onSoftwareSearch}
            />
          ))}
          {hasAnyActive && (
            <button
              type="button"
              data-testid="filter-clear-all"
              onClick={clearAll}
              className="ml-auto text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {t("deviceFilterToolbar.clear")}{" "}
            </button>
          )}
        </div>
      )}

      {/* Clear control when only a search filter is active (no chips). */}
      {!hasChips && hasSearch && (
        <div className="flex items-center">
          <button
            type="button"
            data-testid="filter-clear-all"
            onClick={clearAll}
            className="ml-auto text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {t("deviceFilterToolbar.clear")}{" "}
          </button>
        </div>
      )}

      {/* Advanced drawer */}
      {advancedOpen && (
        <div className="rounded-md border bg-card p-2">
          <FilterSentenceBuilder
            value={value ?? EMPTY_GROUP}
            onChange={(g) => onChange(g.conditions.length === 0 ? null : g)}
            orgs={orgs as NamedRef[]}
            sites={sites as NamedRef[]}
            softwareOptions={softwareOptions}
            onSoftwareSearch={onSoftwareSearch}
          />
        </div>
      )}
    </div>
  );
}
