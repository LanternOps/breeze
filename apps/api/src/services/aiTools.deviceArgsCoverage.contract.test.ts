import { describe, it, expect } from 'vitest';
import { aiTools } from './aiTools';

/**
 * Contract: every AI tool whose input schema exposes a top-level device-id
 * property MUST declare it in `deviceArgs`, so the central dispatch
 * (`executeTool` → `enforceDeviceArgs`) gates that id through the org+site
 * `verifyDeviceAccess` before the handler runs. This is the structural backstop
 * for the parallel-path bug class (a tool author can't forget the per-device
 * tenant check) — see the cross-org incident-tool hole that a missing gate
 * caused.
 *
 * Tools that resolve the device indirectly (vmId/snapshotId/findingId/alertId)
 * or return a device LIST without a device-id input are NOT matched here — they
 * have no device-id property — and continue to narrow results via the
 * `aiToolsSiteScope` helpers.
 *
 * Ratchet: `DEVICE_ARGS_BASELINE` lists tools that expose a device-id property
 * but do not yet declare `deviceArgs`. It is frozen and shrink-only — fixing a
 * tool (adding the declaration) forces removing its baseline entry, and any NEW
 * device-arg tool fails until it declares. Drive this to empty.
 */

// Property names that denote a device the tool acts on (string or string[]).
// Excludes siteId, vmId, snapshotId, findingId, etc. (not direct device ids).
const DEVICE_ID_PROP = /^(?:target)?device_?ids?$/i;

// Tools that expose a device-id property but have not yet been converted to a
// `deviceArgs` declaration. SHRINK ONLY — never add. Each remaining entry is a
// tool whose handler still gates inline (or is pending conversion); the central
// gate is belt-and-suspenders once declared.
const DEVICE_ARGS_BASELINE: ReadonlySet<string> = new Set<string>([]);

function deviceIdProps(tool: { definition: { input_schema?: unknown } }): string[] {
  const schema = tool.definition.input_schema as
    | { properties?: Record<string, unknown> }
    | undefined;
  const props = schema?.properties ?? {};
  return Object.keys(props).filter((k) => DEVICE_ID_PROP.test(k));
}

describe('contract: device-arg tools declare deviceArgs for the central gate', () => {
  const offenders: Array<{ name: string; props: string[]; declared: readonly string[] }> = [];

  for (const [name, tool] of aiTools.entries()) {
    const props = deviceIdProps(tool);
    if (props.length === 0) continue;
    const declared = tool.deviceArgs ?? [];
    const ungated = props.filter((p) => !declared.includes(p));
    if (ungated.length > 0) offenders.push({ name, props: ungated, declared });
  }

  it('every device-id property is covered by deviceArgs (modulo frozen baseline)', () => {
    const newOffenders = offenders.filter((o) => !DEVICE_ARGS_BASELINE.has(o.name));
    if (newOffenders.length > 0) {
      const lines = newOffenders
        .map((o) => `  - ${o.name}: input props [${o.props.join(', ')}] not in deviceArgs [${o.declared.join(', ')}]`)
        .join('\n');
      throw new Error(
        `These tools expose a device-id input property but do not declare it in deviceArgs ` +
          `(add \`deviceArgs: ['<prop>']\` to the tool registration so executeTool gates it):\n${lines}`,
      );
    }
  });

  it('baseline has no stale entries (a fixed tool must be removed from the baseline)', () => {
    const offenderNames = new Set(offenders.map((o) => o.name));
    const stale = [...DEVICE_ARGS_BASELINE].filter((n) => !offenderNames.has(n));
    expect(stale, `stale baseline entries — remove them: ${stale.join(', ')}`).toEqual([]);
  });
});
