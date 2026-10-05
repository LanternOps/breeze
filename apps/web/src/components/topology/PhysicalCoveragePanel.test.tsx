import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import PhysicalCoveragePanel from './PhysicalCoveragePanel';
afterEach(cleanup);

const reason = (code: string, count?: number) => ({ code, message: `server:${code}`, ...(count === undefined ? {} : { count }) });

it('localizes each physical coverage reason distinctly instead of echoing server prose', () => {
  const codes = ['collection_complete_empty', 'collection_unsupported', 'collection_timeout', 'collection_partial_limit', 'collection_partial',
    'credentials_missing', 'interface_unresolved', 'controller_site_unmapped', 'controller_site_other_org', 'no_collector', 'collection_not_received'];
  render(<PhysicalCoveragePanel coverage={{ state: 'limited', reasons: codes.map((code) => reason(code, 2)) }} />);
  const texts = codes.map((code) => screen.getByTestId(`topology-coverage-reason-${code}`).textContent);
  expect(new Set(texts).size).toBe(codes.length);
  for (const text of texts) expect(text).not.toMatch(/^server:/);
  expect(screen.getByTestId('topology-coverage-reason-collection_complete_empty')).toHaveTextContent('does not mean the whole site is covered');
  expect(screen.getByTestId('topology-coverage-reason-collection_timeout')).toHaveTextContent('2');
});

it('falls back to the server message for a reason this build does not know', () => {
  render(<PhysicalCoveragePanel coverage={{ state: 'limited', reasons: [reason('future_reason')] }} />);
  expect(screen.getByTestId('topology-coverage-reason-future_reason')).toHaveTextContent('server:future_reason');
});

it('announces the coverage state and says nothing is missing when complete', () => {
  render(<PhysicalCoveragePanel coverage={{ state: 'complete', reasons: [] }} />);
  expect(screen.getByTestId('topology-coverage')).toHaveTextContent('Complete');
  expect(screen.getByRole('status')).toBeInTheDocument();
});

it('keeps the reasons behind a keyboard-operable disclosure so the status stays one line', () => {
  render(<PhysicalCoveragePanel coverage={{ state: 'limited', reasons: [reason('collection_timeout')] }} />);
  const toggle = screen.getByRole('button', { name: 'Collection coverage' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByTestId('topology-coverage-reasons')).not.toBeVisible();
  toggle.focus();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByTestId('topology-coverage-reasons')).toBeVisible();
  fireEvent.keyDown(screen.getByTestId('topology-coverage-reasons'), { key: 'Escape' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(toggle).toHaveFocus();
});

it('offers no disclosure when there is nothing to explain', () => {
  render(<PhysicalCoveragePanel coverage={{ state: 'complete', reasons: [] }} />);
  expect(screen.queryByRole('button', { name: 'Collection coverage' })).toBeNull();
});
