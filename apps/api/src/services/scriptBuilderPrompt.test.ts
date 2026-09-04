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

/**
 * #4884 — the prompt never explained how Breeze actually delivers runtime
 * parameters to a script, so the assistant guessed CLI args / bare $env:Name /
 * Mandatory param() across multiple customer-visible failed runs before
 * eventually discovering BREEZE_PARAM_* by trial and error. These pin the
 * facts (verified against agent/internal/executor/executor.go buildEnvironment
 * and shell.go SubstituteParameters) into the base prompt so every session
 * gets them for free.
 */
describe('buildScriptBuilderSystemPrompt — runtime parameter delivery', () => {
  const prompt = buildScriptBuilderSystemPrompt();

  it('explains the BREEZE_PARAM_<NAME> env var derivation, including the hyphen-folding example', () => {
    expect(prompt).toContain('BREEZE_PARAM_');
    expect(prompt).toContain('log-level');
    expect(prompt).toContain('BREEZE_PARAM_LOG_LEVEL');
  });

  it('explains the {{name}} / ${{name}} literal substitution path', () => {
    expect(prompt).toContain('{{name}}');
    expect(prompt).toContain('${{name}}');
  });

  it('states parameters are never passed as command-line arguments', () => {
    expect(prompt).toMatch(/never.*(command-line|CLI) argument/i);
  });

  it('tells the assistant never to use a Mandatory param() block for a Breeze parameter', () => {
    expect(prompt).toMatch(/Never write a param\(\) block with a Mandatory/);
  });

  it('tells the assistant never to read a bare $env:<Name>', () => {
    expect(prompt).toContain('$env:<Name>');
  });

  it('distinguishes BREEZE_VAR_* (tenant secrets, SYSTEM/elevated only) from BREEZE_PARAM_*', () => {
    expect(prompt).toContain('BREEZE_VAR_');
    expect(prompt).toMatch(/SYSTEM|elevated/);
  });

  it('instructs checking the actual execution/runAs before theorising about a missing-parameter report', () => {
    expect(prompt).toContain('get_script_execution');
    expect(prompt).toMatch(/runAs/);
  });

  it('forbids embedding a real customer value as a fallback in script code', () => {
    expect(prompt).toMatch(/[Nn]ever embed a real customer value.*fallback/);
  });

  it('renders the derived BREEZE_PARAM_ env var name next to each declared editor parameter', () => {
    const withParams = buildScriptBuilderSystemPrompt({
      editorSnapshot: {
        content: 'Get-ChildItem',
        parameters: [
          { name: 'GoogleEmail', type: 'string', required: true },
          { name: 'log-level', type: 'string' },
        ],
      },
    });
    expect(withParams).toContain('GoogleEmail → $env:BREEZE_PARAM_GOOGLEEMAIL');
    expect(withParams).toContain('log-level → $env:BREEZE_PARAM_LOG_LEVEL');
  });

  it('passes non-hyphen characters through unchanged (only "-" is folded to "_"), matching the agent executor exactly', () => {
    // agent/internal/executor/executor.go buildEnvironment only folds "-" to
    // "_" after upper-casing; a "." or space is NOT sanitized further. This
    // pins that documented discrepancy from the issue's assumption of a
    // general non-alphanumeric sanitizer.
    const withParams = buildScriptBuilderSystemPrompt({
      editorSnapshot: {
        content: 'echo hi',
        parameters: [{ name: 'api.key', type: 'string' }],
      },
    });
    expect(withParams).toContain('api.key → $env:BREEZE_PARAM_API.KEY');
  });
});
