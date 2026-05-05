import { describe, expect, it } from 'vitest';
import {
  getHelperAllowedMcpToolNames,
  getHelperAllowedTools,
  validateHelperToolAccess,
} from './helperToolFilter';

describe('helperToolFilter', () => {
  it('excludes Tier 3 computer control from standard helper access', () => {
    expect(getHelperAllowedTools('standard')).not.toContain('computer_control');
    expect(getHelperAllowedMcpToolNames('standard')).not.toContain('mcp__breeze__computer_control');
    expect(validateHelperToolAccess('computer_control', 'standard')).toContain('not available');
  });

  it('keeps computer control limited to extended helper access', () => {
    expect(getHelperAllowedTools('extended')).toContain('computer_control');
    expect(validateHelperToolAccess('mcp__breeze__computer_control', 'extended')).toBeNull();
  });
});
