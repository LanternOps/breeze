/**
 * #10406 item 1 — launch_specialist's model-facing text must not promise what
 * the coordinator refuses: `analysis` needs the workspace flag
 * (coordinator.ts `analysis_not_available`) and `sweep` needs an enabled
 * partner sweep schedule (specialistLaunchers.ts `no_sweep_schedule`). The
 * text follows aiWorkspaceEnabled(); the kind enum is unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { AiTool } from './aiTools';
import { launchSpecialistDescription, registerWispTools } from './aiToolsWisp';
import { launchSpecialistKindDescribe, launchSpecialistShapeFor } from './aiToolSchemas';

describe('launch_specialist text (#10406 item 1)', () => {
  for (const enabled of [false, true]) {
    const texts = () => [launchSpecialistDescription(enabled), launchSpecialistKindDescribe(enabled)];

    describe(`workspace ${enabled ? 'on' : 'off'}`, () => {
      it('no longer uses the old unconditional or conditional-prose phrasing', () => {
        for (const text of texts()) {
          expect(text).not.toMatch(/sweep, analysis, device_troubleshooting run now/);
          expect(text).not.toMatch(/sweep, analysis and device_troubleshooting start at once/);
          expect(text).not.toContain('analysis if workspace on');
          expect(text).not.toContain('analysis (needs workspace)');
        }
      });

      it('states which kinds run after one card: assessment, device_troubleshooting, sweep if scheduled', () => {
        for (const text of texts()) {
          expect(text).toMatch(/^After one card: [^.]*assessment \{scope\?/);
          expect(text).toMatch(/^After one card: [^.]*device_troubleshooting/);
          expect(text).toMatch(/sweep if scheduled/);
        }
        // The scope values ride on the kind field (the description is at its cap).
        expect(launchSpecialistKindDescribe(enabled)).toContain('assessment {scope?: org|orgs_with_open_alerts}');
      });

      it('reads as plain sentences: every period and colon is followed by a space', () => {
        for (const text of texts()) expect(text).not.toMatch(/[.:;,][^\s]/);
      });

      it('stays within the description budget and keeps the strict param keys', () => {
        const d = launchSpecialistDescription(enabled);
        expect(d.length).toBeLessThanOrEqual(300);
        expect(launchSpecialistKindDescribe(enabled).length).toBeLessThanOrEqual(160);
        for (const k of ['continueFromRunId?', 'holdTickets?', 'workflowVersion', 'recipeInput', 'ticketIds']) {
          expect(d).toContain(k);
        }
      });

      it('shape kind describe matches and the enum is unchanged', () => {
        const shape = launchSpecialistShapeFor(enabled);
        expect(shape.kind.description).toBe(launchSpecialistKindDescribe(enabled));
        expect(launchSpecialistShapeFor(!enabled).kind.options).toEqual(shape.kind.options);
      });
    });
  }

  it('workspace off: says analysis is off on this server', () => {
    expect(launchSpecialistDescription(false)).toContain('analysis is off on this server');
    expect(launchSpecialistKindDescribe(false)).toContain('analysis is off');
  });

  it('workspace on: lists analysis among the runs-after-the-card kinds and not as off', () => {
    for (const text of [launchSpecialistDescription(true), launchSpecialistKindDescribe(true)]) {
      expect(text).toMatch(/assessment[^.]*,\s*analysis/);
      expect(text).not.toMatch(/analysis is off/);
    }
  });

  it('registerWispTools follows the env flag (off in the default test env)', () => {
    const tools = new Map<string, AiTool>();
    registerWispTools(tools);
    expect(tools.get('launch_specialist')!.definition.description).toBe(launchSpecialistDescription(false));
  });
});
