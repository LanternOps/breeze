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
 * do not currently expose a top-level device-id property, so the regex does not
 * match them; they continue to narrow via the `aiToolsSiteScope` helpers. If
 * such a tool later adds a device-id filter it must declare it like any other.
 * NOTE: coverage is only as strong as `DEVICE_ID_PROP` — a device-id input
 * named outside this pattern (e.g. `agentId`) would be both ungated and
 * invisible here. All device-id props in this codebase are device(s)/-id(s)
 * shaped; keep it that way or widen the pattern.
 *
 * Ratchet: `DEVICE_ARGS_BASELINE` lists tools that expose a device-id property
 * but do not yet declare `deviceArgs`. It is frozen and shrink-only — fixing a
 * tool (adding the declaration) forces removing its baseline entry, and any NEW
 * device-arg tool fails until it declares. Drive this to empty.
 */

// Property names that carry a device id / list of device ids (string or
// string[]): device(s), with an optional target/affected/source prefix and an
// optional id(s) suffix — e.g. deviceId, deviceIds, device_id, targetDeviceId,
// targetDevices, devices, affectedDeviceIds. Deliberately does NOT match
// agentId (the agent, not the device), siteId, vmId, snapshotId, or
// deviceGroupId (a group, not a device).
const DEVICE_ID_PROP = /^(?:target|affected|source)?_?devices?(?:_?ids?)?$/i;

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

  it('every declared deviceArgs name exists as an input_schema property (no typos / dead declarations)', () => {
    const bad: string[] = [];
    for (const [name, tool] of aiTools.entries()) {
      const declared = tool.deviceArgs ?? [];
      if (declared.length === 0) continue;
      const schema = tool.definition.input_schema as { properties?: Record<string, unknown> } | undefined;
      const props = new Set(Object.keys(schema?.properties ?? {}));
      for (const arg of declared) {
        if (!props.has(arg)) bad.push(`${name}: deviceArgs entry '${arg}' is not an input_schema property`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
