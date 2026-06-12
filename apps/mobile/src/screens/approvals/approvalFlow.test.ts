import { describe, expect, it } from 'vitest';
import { resolveApprovalFlowType, UAC_INTERCEPT_TOOL } from './approvalFlow';

describe('resolveApprovalFlowType', () => {
  it('prefers the server-issued flowType when present', () => {
    expect(
      resolveApprovalFlowType({ flowType: 'uac_intercept', actionToolName: 'something_else' }),
    ).toBe('uac_intercept');
    expect(
      resolveApprovalFlowType({ flowType: 'mcp_tool', actionToolName: UAC_INTERCEPT_TOOL }),
    ).toBe('standard');
  });

  it('falls back to actionToolName when flowType is absent/blank', () => {
    expect(resolveApprovalFlowType({ actionToolName: UAC_INTERCEPT_TOOL })).toBe('uac_intercept');
    expect(resolveApprovalFlowType({ flowType: '   ', actionToolName: UAC_INTERCEPT_TOOL })).toBe(
      'uac_intercept',
    );
    expect(resolveApprovalFlowType({ flowType: null, actionToolName: UAC_INTERCEPT_TOOL })).toBe(
      'uac_intercept',
    );
  });

  it('defaults to standard for any other tool', () => {
    expect(resolveApprovalFlowType({ actionToolName: 'm365_reset_password' })).toBe('standard');
    expect(resolveApprovalFlowType({ actionToolName: '' })).toBe('standard');
  });
});
