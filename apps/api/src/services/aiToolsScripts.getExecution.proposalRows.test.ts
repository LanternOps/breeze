import { describe, expect, it } from 'vitest';
import { __testOnly } from './aiToolsScripts';

describe('get_script_execution row shaping', () => {
  it('reports a proposal-backed row with its own source and provenance', () => {
    const shaped = __testOnly.shapeExecutionRow({
      id: 'e1', sourceKind: 'proposal', proposalId: 'p1', scriptId: null, scriptName: null,
      language: 'powershell', timeoutSeconds: 300, reviewRiskTier: 'medium',
      reviewSummary: 'restarts the spooler', approvalMethod: 'supervised_self',
    } as never);
    expect(shaped.sourceKind).toBe('proposal');
    expect(shaped.proposalId).toBe('p1');
    expect(shaped.scriptName).toBe('AI-authored proposal');
    expect(shaped.language).toBe('powershell');
  });

  it('keeps a library row rendering exactly as before', () => {
    const shaped = __testOnly.shapeExecutionRow({
      id: 'e1', sourceKind: 'library', proposalId: null, scriptId: 's1', scriptName: 'Clear print queue',
      language: null, timeoutSeconds: null, scriptLanguage: 'powershell',
    } as never);
    expect(shaped.scriptName).toBe('Clear print queue');
    expect(shaped.language).toBe('powershell');
  });
});
