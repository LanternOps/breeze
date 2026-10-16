import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import AiChatMessages from './AiChatMessages';

vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <span>{children}</span> }));
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('./AiToolCallCard', () => ({ default: () => <div data-testid="tool-card" /> }));
vi.mock('./AiPlanReviewCard', () => ({ default: () => null }));
vi.mock('./AiPlanProgressBar', () => ({ default: () => null }));
vi.mock('../callerVerification/CallerVerificationRefusal', () => ({
  CallerVerificationRefusal: (p: { output: unknown; isError?: boolean }) =>
    <div data-testid="cv-refusal-stub" data-output={JSON.stringify(p.output)} data-error={String(!!p.isError)} />,
}));

it('renders the caller-verification refusal beside the tool result card with the raw output and error flag', () => {
  const output = { error: 'Caller verification required', requiresCallerVerification: { reason: 'grant_consumed' } };
  render(<AiChatMessages pendingApproval={null} onApprove={vi.fn()} onReject={vi.fn()} messages={[
    { id: 'u', role: 'tool_use', content: '', toolName: 'm365_reset_password', toolUseId: 't1', toolInput: {} },
    { id: 'r', role: 'tool_result', content: '', toolName: 'm365_reset_password', toolUseId: 't1', toolOutput: output, isError: true },
  ] as never} />);
  expect(screen.getAllByTestId('tool-card').length).toBeGreaterThan(0);
  const stub = screen.getByTestId('cv-refusal-stub');
  expect(JSON.parse(stub.getAttribute('data-output')!)).toEqual(output);
  expect(stub).toHaveAttribute('data-error', 'true');
});
