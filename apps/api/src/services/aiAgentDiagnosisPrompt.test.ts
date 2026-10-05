import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import './aiTools'; // populates the registry
import { aiTools } from './aiTools';
import { listChatSurfaceToolNames } from './aiAgentSdkTools';
import { composeStaticSystemPrompt } from './aiToolIndex';
import { executeCommandShape } from './aiToolSchemas';
import { AI_SYSTEM_PROMPT_DIAGNOSIS, BREEZE_AGENT_WINDOWS_FACTS, type BreezeAgentFactAnchor } from './aiAgentDiagnosisPrompt';

// #7582 — a technician asked the chat about WmiPrvSE CPU on a Windows box
// running three other vendors' agents. The model blamed the Breeze agent with a
// retry loop that does not exist, then (after the tech cleared us) blamed
// another vendor without resolving the PID. These tests pin the prompt rules
// that close those two gaps, and pin the agent ground-truth list to the Go
// source so it fails here, not in a customer chat, when the agent changes.

const AGENT_ROOT = fileURLToPath(new URL('../../../../agent/', import.meta.url));

function anchorViolations(src: string, anchor: BreezeAgentFactAnchor): string[] {
  return [
    ...anchor.contains.filter((needle) => !src.includes(needle)).map((n) => `missing ${JSON.stringify(n)}`),
    ...(anchor.absent ?? []).filter((needle) => src.includes(needle)).map((n) => `unexpectedly contains ${JSON.stringify(n)}`),
  ];
}

describe('attribution discipline (#7582 ask 1)', () => {
  it('requires resolving a PID to its image, service and account before naming a culprit', () => {
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/before naming a process, vendor or the Breeze agent as (a|the) (root )?cause/i);
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/tasklist \/svc/);
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/ParentProcessId/);
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/WMI-Activity\/Operational/);
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/ClientProcessId/);
  });

  it('makes an unchecked attribution say so instead of guessing', () => {
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/unattributed/i);
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/correlation, not attribution/i);
  });

  it('requires each diagnostic claim to be labelled verified or inferred', () => {
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/label each claim in a diagnosis verified \([^)]*\) or inferred/i);
  });

  it('forbids stating Breeze agent mechanics that are not in the ground-truth list', () => {
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/never state a Breeze agent (behavior|behaviour|mechanism)[^.]*not (listed|in this list)/i);
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/Breeze support only when attribution to the Breeze agent is verified/);
    // An unlisted behavior is "not documented", never a denial.
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/not documented, which does not mean the agent never does it/);
    expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toMatch(/not exhaustive/);
  });

  it('is part of the static chat prompt, under its own budget', () => {
    expect(composeStaticSystemPrompt(listChatSurfaceToolNames())).toContain(AI_SYSTEM_PROMPT_DIAGNOSIS);
    // Separate from the BASE+TAIL 7 KB budget on purpose: this block grows
    // with the agent, so its cost is measured on its own. 3738 bytes at #7582
    // (2864 before the PR review corrected overstated facts: an incomplete or
    // rounded-off ground truth is worse than a longer one). A raise needs a
    // prompt-size review, not a bump: trim wording first.
    expect(Buffer.byteLength(AI_SYSTEM_PROMPT_DIAGNOSIS, 'utf8')).toBeLessThan(4 * 1024);
  });
});

describe('Breeze agent Windows ground truth (#7582 ask 2)', () => {
  it('has facts, each rendered verbatim into the prompt section', () => {
    expect(BREEZE_AGENT_WINDOWS_FACTS.length).toBeGreaterThan(3);
    for (const fact of BREEZE_AGENT_WINDOWS_FACTS) {
      expect(AI_SYSTEM_PROMPT_DIAGNOSIS).toContain(`- ${fact.text}`);
    }
  });

  // The anchor strings are the Go declarations that make each fact true
  // (identifier AND value). Renaming a collector, deleting it, or changing its
  // cadence breaks this test, which is the point: update the fact text in the
  // same PR, or the chat will describe an agent that no longer exists.
  it.each(BREEZE_AGENT_WINDOWS_FACTS.map((f) => [f.text.slice(0, 60), f] as const))(
    'every anchor still holds in agent source: %s',
    (_label, fact) => {
      expect(fact.anchors.length).toBeGreaterThan(0);
      for (const anchor of fact.anchors) {
        const path = join(AGENT_ROOT, anchor.file);
        expect(existsSync(path), `${anchor.file} is missing from agent/`).toBe(true);
        expect(anchorViolations(readFileSync(path, 'utf8'), anchor), anchor.file).toEqual([]);
      }
    },
  );

  // Control: the same matcher the test above uses must report a violation
  // when a real anchored source drifts. Mutates an in-memory copy only.
  it('the anchor matcher reports drift in a real anchored file (control)', () => {
    const anchor = BREEZE_AGENT_WINDOWS_FACTS.flatMap((f) => f.anchors)
      .find((a) => a.file === 'internal/collectors/hwhealth/breaker.go')!;
    const src = readFileSync(join(AGENT_ROOT, anchor.file), 'utf8');
    expect(anchorViolations(src, anchor)).toEqual([]);
    const changedValue = src.replace('now.Add(6 * time.Hour)', 'now.Add(4 * time.Hour)');
    expect(changedValue).not.toBe(src);
    expect(anchorViolations(changedValue, anchor)).toEqual(['missing "b.retryAt = now.Add(6 * time.Hour)"']);

    const hw = BREEZE_AGENT_WINDOWS_FACTS.flatMap((f) => f.anchors)
      .find((a) => a.file === 'internal/collectors/hardware_windows.go')!;
    const hwSrc = readFileSync(join(AGENT_ROOT, hw.file), 'utf8');
    expect(anchorViolations(`${hwSrc}\n# Get-StoragePool\n`, hw)).toEqual(['unexpectedly contains "StoragePool"']);
  });
});

describe('evidence before a process kill (#7582 ask 3)', () => {
  it('manage_processes tells the model to restate labelled evidence before kill', () => {
    const d = aiTools.get('manage_processes')!.definition.description;
    expect(d).toMatch(/before kill/i);
    expect(d).toMatch(/verified or inferred/i);
  });

  it('execute_command tells the model to restate labelled evidence before kill_process', () => {
    const schema = aiTools.get('execute_command')!.definition.input_schema as {
      properties: { commandType: { description: string } };
    };
    expect(schema.properties.commandType.description).toMatch(/before kill_process/i);
    expect(schema.properties.commandType.description).toMatch(/verified or inferred/i);
  });

  // The chat surface declares execute_command from this zod shape, not from the
  // registry input_schema, so the rule has to be on both or chat never sees it.
  it('the chat-surface execute_command schema carries the same rule', () => {
    expect(executeCommandShape.commandType.description).toMatch(/before kill_process/i);
    expect(executeCommandShape.commandType.description).toMatch(/verified or inferred/i);
  });
});
