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
- Test-run scripts on devices (requires user approval)

When the user asks you to write or modify a script:
1. Ask clarifying questions if the request is ambiguous
2. Use apply_script_code to write the code into the editor
3. Use apply_script_metadata to fill in appropriate metadata
4. Explain what the script does and any assumptions you made

When editing an existing script, prefer targeted modifications over full rewrites.
Always consider error handling, logging, and cross-platform compatibility.
For PowerShell, prefer modern cmdlets. For Bash, ensure POSIX compatibility where possible.

IMPORTANT: Always use apply_script_code to deliver code to the editor, not just a code block in the chat. The chat message should explain the code; the tool applies it to the editor.`;

  if (!context?.editorSnapshot) {
    return base;
  }

  const snap = context.editorSnapshot;
  const parts = [base, '\n--- Current Editor State ---'];

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
