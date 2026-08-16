import { describe, expect, it } from 'vitest';
import { buildScriptBuilderSystemPrompt } from './scriptBuilderPrompt';

/**
 * The editor test-loop relies on the system prompt carrying three context ids
 * (saved script, pinned test device, last test-run execution) so the model can
 * run and read results without guessing via list_scripts. These were silently
 * droppable before (#scriptId existed in the type but was never rendered), so
 * pin their presence and absence explicitly.
 */

const SCRIPT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const EXECUTION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('buildScriptBuilderSystemPrompt', () => {
  it('returns the base prompt when no context is given', () => {
    const prompt = buildScriptBuilderSystemPrompt();
    expect(prompt).toContain('script-writing assistant');
    expect(prompt).not.toContain('Saved script ID');
    expect(prompt).not.toContain('Pinned test device');
    expect(prompt).not.toContain('--- Current Editor State ---');
  });

  it('renders scriptId, targetDeviceId, and lastTestExecutionId when present without a snapshot', () => {
    const prompt = buildScriptBuilderSystemPrompt({
      scriptId: SCRIPT_ID,
      targetDeviceId: DEVICE_ID,
      lastTestExecutionId: EXECUTION_ID,
    });
    expect(prompt).toContain(`Saved script ID: ${SCRIPT_ID}`);
    expect(prompt).toContain(`Pinned test device ID: ${DEVICE_ID}`);
    expect(prompt).toContain(`Most recent editor test-run execution ID: ${EXECUTION_ID}`);
  });

  it('renders the context ids alongside the editor snapshot', () => {
    const prompt = buildScriptBuilderSystemPrompt({
      scriptId: SCRIPT_ID,
      targetDeviceId: DEVICE_ID,
      editorSnapshot: { name: 'Cleanup', language: 'powershell', content: 'Get-ChildItem' },
    });
    expect(prompt).toContain(`Saved script ID: ${SCRIPT_ID}`);
    expect(prompt).toContain(`Pinned test device ID: ${DEVICE_ID}`);
    expect(prompt).toContain('--- Current Editor State ---');
    expect(prompt).toContain('Get-ChildItem');
  });

  it('omits context lines that are absent', () => {
    const prompt = buildScriptBuilderSystemPrompt({
      editorSnapshot: { content: 'echo hi' },
    });
    expect(prompt).not.toContain('Saved script ID');
    expect(prompt).not.toContain('Pinned test device');
    expect(prompt).not.toContain('Most recent editor test-run execution ID');
    expect(prompt).toContain('echo hi');
  });
});
