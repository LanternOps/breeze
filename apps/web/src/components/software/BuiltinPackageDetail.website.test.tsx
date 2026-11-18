import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BuiltinPackageDetail from './BuiltinPackageDetail';

describe('BuiltinPackageDetail website link', () => {
  it('separates the provider name from "website" with a space', () => {
    render(
      <BuiltinPackageDetail
        name="SentinelOne Agent"
        provider="sentinelone"
        readiness={{ status: 'unknown', checks: [] }}
        onDeploy={vi.fn()}
      />,
    );
    const link = screen.getByRole('link', { name: /website/i });
    expect(link.textContent).toMatch(/SentinelOne website/);
  });
});
