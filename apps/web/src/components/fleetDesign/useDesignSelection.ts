import { useCallback, useState } from "react";
import type { FleetDesignApproval } from "@breeze/shared";

/**
 * Fleet Designer W03 (#5653) — per-item checkbox state for the Fleet Design
 * viewer, keyed by the server-assigned `itemRef` grammar
 * (`packages/shared/src/types/fleetDesignApply.ts`).
 *
 * Two rules the viewer needs, encoded here so `FleetDesignViewer` stays a
 * dumb renderer:
 *  - Selecting a `monitoring:<key>:watch|rule:<n>` item also selects its
 *    owning `functions:<key>` — monitoring has nothing to attach to without
 *    the function's device group, so picking one without the other would
 *    produce a preview blocker the technician didn't ask for.
 *  - A ref with an `applied` ledger row is not selectable at all: `toggle`
 *    no-ops on it, so a stray click can never re-queue something already on
 *    the device fleet.
 *
 * `toApproval` builds everything BUT `displacementsAccepted`, which the
 * apply drawer owns (it is populated from a preview response the selection
 * here doesn't have), and `automation`/`legacy`, which are W04 — the current
 * viewer renders those two sections read-only with no checkboxes.
 */
const FUNCTIONS_PREFIX = "functions:";
const MONITORING_PREFIX = "monitoring:";
const RETIRED_PREFIX = "retired:";
const ROLE_CORRECTIONS_PREFIX = "roleCorrections:";

/** `monitoring:<key>:watch:<n>` / `monitoring:<key>:rule:<n>` -> `functions:<key>`. */
export function owningFunctionRef(monitoringRef: string): string | null {
  const m = /^monitoring:(.+):(?:watch|rule):\d+$/.exec(monitoringRef);
  return m ? `${FUNCTIONS_PREFIX}${m[1]}` : null;
}

export interface UseDesignSelectionResult {
  selected: ReadonlySet<string>;
  isSelected: (ref: string) => boolean;
  /** True when `ref` already has an `applied` ledger row — not selectable. */
  isApplied: (ref: string) => boolean;
  toggle: (ref: string) => void;
  clear: () => void;
  /** The approval body for the current selection, minus `displacementsAccepted`
   *  (owned by the apply drawer) — spread that in before posting. */
  toApproval: () => Omit<FleetDesignApproval, "displacementsAccepted">;
}

export function useDesignSelection(appliedRefs: ReadonlySet<string>): UseDesignSelectionResult {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const isApplied = useCallback((ref: string) => appliedRefs.has(ref), [appliedRefs]);
  const isSelected = useCallback((ref: string) => selected.has(ref), [selected]);

  const toggle = useCallback(
    (ref: string) => {
      if (appliedRefs.has(ref)) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(ref)) {
          next.delete(ref);
          return next;
        }
        next.add(ref);
        if (ref.startsWith(MONITORING_PREFIX)) {
          const fnRef = owningFunctionRef(ref);
          if (fnRef && !appliedRefs.has(fnRef)) next.add(fnRef);
        }
        return next;
      });
    },
    [appliedRefs],
  );

  const clear = useCallback(() => setSelected(new Set()), []);

  const toApproval = useCallback((): Omit<FleetDesignApproval, "displacementsAccepted"> => {
    const functions: string[] = [];
    const monitoring: string[] = [];
    const retired: string[] = [];
    const roleCorrections: string[] = [];
    for (const ref of selected) {
      if (ref.startsWith(FUNCTIONS_PREFIX)) functions.push(ref.slice(FUNCTIONS_PREFIX.length));
      else if (ref.startsWith(MONITORING_PREFIX)) monitoring.push(ref);
      else if (ref.startsWith(RETIRED_PREFIX)) retired.push(ref);
      else if (ref.startsWith(ROLE_CORRECTIONS_PREFIX)) roleCorrections.push(ref.slice(ROLE_CORRECTIONS_PREFIX.length));
    }
    return { functions, monitoring, retired, roleCorrections, automation: [], legacy: [] };
  }, [selected]);

  return { selected, isSelected, isApplied, toggle, clear, toApproval };
}
