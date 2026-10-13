import '@/lib/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CallerVerificationRefusal, parseRefusal } from './CallerVerificationRefusal';
import { ORG, CONTACT, row } from './testFixtures';

const enabled = vi.hoisted(() => ({ value: true }));
const modal = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => enabled.value }));
vi.mock('./VerifyCallerModal', () => ({
  VerifyCallerModal: (p: Record<string, unknown>) => { modal.props = p; return <div data-testid="inline-cv" />; },
}));
afterEach(() => { enabled.value = true; modal.props = null; });

const payload = { orgId: ORG, contactId: CONTACT, action: 'reset_password', requiredTier: 2, reason: 'grant_consumed', latest: null };
const routeBody = { error: 'caller_verification_required', requiresCallerVerification: payload };
const toolBody = { error: 'Caller verification required', requiresCallerVerification: payload };

it('parses the route and tool envelopes, as objects or JSON strings', () => {
  expect(parseRefusal(routeBody)?.orgId).toBe(ORG);
  expect(parseRefusal(JSON.stringify(toolBody))?.action).toBe('reset_password');
});

it('rejects missing scope, malformed payloads and unrelated output', () => {
  expect(parseRefusal({ requiresCallerVerification: { contactId: CONTACT, requiredTier: 2, reason: 'grant_consumed' } })).toBeNull();
  expect(parseRefusal({ requiresCallerVerification: { ...payload, orgId: 'not-a-uuid' } })).toBeNull();
  expect(parseRefusal('{')).toBeNull();
  expect(parseRefusal('Caller verification required')).toBeNull();
  expect(parseRefusal({ ok: true })).toBeNull();
  expect(parseRefusal(null)).toBeNull();
});

it('renders the human reason and tier, never the raw code, and opens the modal pinned to the refusal org and action', () => {
  render(<CallerVerificationRefusal output={JSON.stringify(toolBody)} isError />);
  expect(screen.getByText('The last verification was already used for another action.')).toBeVisible();
  expect(screen.getByText('This action needs a tier 2 verification.')).toBeVisible();
  expect(document.body.textContent).not.toContain('grant_consumed');
  fireEvent.click(screen.getByTestId('cv-refusal-verify'));
  expect(modal.props).toMatchObject({ orgId: ORG, initialContactId: CONTACT, initialAction: 'reset_password' });
  expect(modal.props?.lockContact).toBeFalsy();
});

it('uses generic copy for an unknown reason', () => {
  render(<CallerVerificationRefusal output={{ requiresCallerVerification: { ...payload, reason: 'something_new' } }} isError />);
  expect(screen.getByText('The caller must be verified before this action.')).toBeVisible();
  expect(document.body.textContent).not.toContain('something_new');
});

it('tells the technician to ask the assistant again after a usable verification, without retrying anything', async () => {
  render(<CallerVerificationRefusal output={toolBody} isError />);
  fireEvent.click(screen.getByTestId('cv-refusal-verify'));
  await act(async () => {
    (modal.props!.onChanged as (r: unknown) => void)({ ...row, status: 'verified', usableUntil: new Date(Date.now() + 60000).toISOString() });
  });
  expect(screen.getByText('Caller verified. Ask the assistant to try again.')).toBeVisible();
});

it('renders nothing for a success result, an unrelated error, or while the feature is off', () => {
  const view = render(<CallerVerificationRefusal output={toolBody} isError={false} />);
  expect(screen.queryByTestId('cv-refusal')).toBeNull();
  view.rerender(<CallerVerificationRefusal output={{ error: 'boom' }} isError />);
  expect(screen.queryByTestId('cv-refusal')).toBeNull();
  enabled.value = false;
  view.rerender(<CallerVerificationRefusal output={toolBody} isError />);
  expect(screen.queryByTestId('cv-refusal')).toBeNull();
});
