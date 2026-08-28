import { describe, it, expect } from 'vitest';
import {
  AI_AGENT_RUN_DTO_SCHEMA_VERSION,
  AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS,
  type AiAgentRunDetailDto,
  type AiAgentRunTraceEntryDto,
} from './aiAgentRuns';

/**
 * Compile-time exhaustiveness check on the trace-entry union. If a fourth
 * variant is ever added to `AiAgentRunTraceEntryDto` without a matching
 * branch here, `x` narrows to something other than `never` and `tsc` fails
 * the assignment below — this function is never called at runtime, it only
 * has to type-check.
 */
function assertTraceEntryExhaustive(entry: AiAgentRunTraceEntryDto): string {
  switch (entry.kind) {
    case 'executed':
      return entry.tool;
    case 'proposed':
      return entry.tool;
    case 'denied':
      return entry.tool;
    default: {
      const neverEntry: never = entry;
      throw new Error(`unreachable: ${JSON.stringify(neverEntry)}`);
    }
  }
}

describe('AiAgentRunTraceEntryDto (leak-impossible union, #3828)', () => {
  it('exhausts all three variants at compile time (assertTraceEntryExhaustive type-checks)', () => {
    const executed: AiAgentRunTraceEntryDto = { kind: 'executed', tool: 'run_script', result: 'ok', durationMs: 120 };
    const proposed: AiAgentRunTraceEntryDto = { kind: 'proposed', tool: 'manage_services' };
    const denied: AiAgentRunTraceEntryDto = { kind: 'denied', tool: 'delete_file', reason: 'not allowlisted' };
    expect(assertTraceEntryExhaustive(executed)).toBe('run_script');
    expect(assertTraceEntryExhaustive(proposed)).toBe('manage_services');
    expect(assertTraceEntryExhaustive(denied)).toBe('delete_file');
  });

  it('has no field literally named args/toolInput/toolOutput/arguments/input/output on any sample variant', () => {
    const samples: AiAgentRunTraceEntryDto[] = [
      {
        kind: 'executed',
        tool: 'manage_services',
        action: 'restart',
        result: 'ok',
        durationMs: 340,
        execution: 'succeeded',
        verification: 'passed',
        verifyDetail: 'service running',
        actOpKey: 'manage_services.restart',
        actTargetName: 'wuauserv',
      },
      {
        kind: 'proposed',
        tool: 'run_script',
        action: 'invoke',
        intentId: '11111111-1111-4111-8111-111111111111',
        downgradeReason: 'missing identity field',
      },
      { kind: 'denied', tool: 'delete_registry_key', reason: 'protected resource' },
    ];
    for (const sample of samples) {
      const keys = Object.keys(sample);
      for (const forbidden of [...AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS, 'input', 'output']) {
        expect(keys).not.toContain(forbidden);
      }
      // Belt + suspenders: the serialized form must not contain the forbidden
      // substrings either (catches a forbidden key nested one level down).
      const json = JSON.stringify(sample);
      for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
        expect(json).not.toContain(`"${forbidden}"`);
      }
    }
  });
});

describe('AI_AGENT_RUN_DTO_SCHEMA_VERSION', () => {
  it('is the literal 1', () => {
    expect(AI_AGENT_RUN_DTO_SCHEMA_VERSION).toBe(1);
  });

  it('stamps every DTO sample with schemaVersion: 1', () => {
    const detail: Pick<AiAgentRunDetailDto, 'schemaVersion'> = { schemaVersion: AI_AGENT_RUN_DTO_SCHEMA_VERSION };
    expect(detail.schemaVersion).toBe(1);
  });
});
