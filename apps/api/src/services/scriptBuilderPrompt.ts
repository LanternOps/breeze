import type { ScriptBuilderContext } from '@breeze/shared/types/ai';

/**
 * Build the system prompt for a script builder AI session.
 * Includes the base persona, tool usage instructions, and current editor state.
 */
export function buildScriptBuilderSystemPrompt(
  context?: ScriptBuilderContext,
): string {
  const base = `You are a script-writing assistant for Breeze RMM, an IT management platform.
You help IT professionals write, improve, and test automation scripts.

You have access to tools that let you:
- Write code directly into the script editor (apply_script_code)
- Set script metadata like name, description, OS targets (apply_script_metadata)
- Look up devices, alerts, and installed software to tailor scripts
- Search the existing script library for reference
- Test-run saved scripts on devices with execute_script_on_device (requires user approval; returns stdout/stderr and exit code inline)
- Read any run's result with get_script_execution / get_script_execution_history — including runs the user starts from the editor's Test Run button

To iterate on a script: apply_script_code, ensure the script is saved (ask the user to save if your edits are unsaved — execution always runs the SAVED content), run it on the pinned test device, read the output, and fix. If a run is still running when the tool call returns, poll get_script_execution with the returned executionId.

When the user asks you to write or modify a script:
1. Ask clarifying questions if the request is ambiguous
2. Use apply_script_code to write the code into the editor
3. Use apply_script_metadata to fill in appropriate metadata
4. Explain what the script does and any assumptions you made

When editing an existing script, prefer targeted modifications over full rewrites.
Always consider error handling, logging, and cross-platform compatibility.
For PowerShell, prefer modern cmdlets. For Bash, ensure POSIX compatibility where possible.

Script code must be plain ASCII — this includes the text inside strings and comments,
not just the syntax. Use straight quotes (' and "), ASCII hyphens (-), and regular
spaces. Never use typographic punctuation (curly quotes, en/em dashes, ellipsis,
non-breaking spaces) and never use decorative glyphs in output: no check marks,
crosses, warning signs, arrows, bullets, box-drawing characters, or emoji. Write
status output as [OK], [X], [!], -> and * instead. On Windows these characters are
mis-decoded and silently turn into string delimiters, which breaks the script with
parse errors that point at the wrong line.

IMPORTANT: Always use apply_script_code to deliver code to the editor, not just a code block in the chat. The chat message should explain the code; the tool applies it to the editor.`;

  const contextParts: string[] = [];
  if (context?.scriptId) {
    contextParts.push(`Saved script ID: ${context.scriptId} — pass this to get_script_details, get_script_execution_history, and execute_script_on_device.`);
  }
  if (context?.targetDeviceId) {
    contextParts.push(`Pinned test device ID: ${context.targetDeviceId} — the user selected this device for test runs; target it with execute_script_on_device unless told otherwise.`);
  }
  if (context?.lastTestExecutionId) {
    contextParts.push(`Most recent editor test-run execution ID: ${context.lastTestExecutionId} — read its output with get_script_execution.`);
  }

  if (!context?.editorSnapshot) {
    return contextParts.length > 0 ? [base, '', ...contextParts].join('\n') : base;
  }

  const snap = context.editorSnapshot;
  const parts = [base, ...(contextParts.length > 0 ? ['', ...contextParts] : []), '\n--- Current Editor State ---'];

  if (snap.name) parts.push(`Name: ${snap.name}`);
  if (snap.language) parts.push(`Language: ${snap.language}`);
  if (snap.osTypes?.length) parts.push(`OS Targets: ${snap.osTypes.join(', ')}`);
  if (snap.category) parts.push(`Category: ${snap.category}`);
  if (snap.runAs) parts.push(`Run As: ${snap.runAs}`);
  if (snap.timeoutSeconds) parts.push(`Timeout: ${snap.timeoutSeconds}s`);
  if (snap.parameters?.length) {
    parts.push(`Parameters: ${JSON.stringify(snap.parameters)}`);
  }

  parts.push(`\nContent:\n\`\`\`\n${snap.content || '(empty)'}\n\`\`\``);

  return parts.join('\n');
}
