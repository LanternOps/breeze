/**
 * #10406 item 1 — launch_specialist's model-facing text must not promise what
 * the coordinator refuses: `analysis` needs the workspace flag
 * (coordinator.ts `analysis_not_available`) and `sweep` needs an enabled
 * partner sweep schedule (specialistLaunchers.ts `no_sweep_schedule`).
 */
import { describe, expect, it } from 'vitest';
import type { AiTool } from './aiTools';
import { registerWispTools } from './aiToolsWisp';
import { launchSpecialistShape } from './aiToolSchemas';

const tools = new Map<string, AiTool>();
registerWispTools(tools);
const description = tools.get('launch_specialist')!.definition.description;
const kindText = launchSpecialistShape.kind.description ?? '';

describe('launch_specialist description (#10406 item 1)', () => {
  it('no longer advertises sweep/analysis as starting unconditionally', () => {
    expect(description).not.toMatch(/sweep, analysis, device_troubleshooting run now/);
    expect(kindText).not.toMatch(/sweep, analysis and device_troubleshooting start at once/);
  });

  it('states the sweep schedule and analysis workspace prerequisites', () => {
    for (const text of [description, kindText]) {
      expect(text).toMatch(/sweep[^.;]*schedule/i);
      expect(text).toMatch(/analysis[^.;]*workspace/i);
    }
  });
});
