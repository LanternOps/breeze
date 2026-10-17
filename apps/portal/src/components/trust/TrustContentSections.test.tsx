// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import TrustFaq from './TrustFaq';
import TrustHistory from './TrustHistory';
import TrustSubprocessors from './TrustSubprocessors';
import { TrustLocaleContext, type TrustSectionViewProps } from './trustCopy';

const NOW = '2026-10-17T00:00:00.000Z';
const day = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const props = (over: Record<string, unknown> = {}): TrustSectionViewProps => ({
  payload: {
    locale: 'en', generatedAt: NOW, subprocessors: [], faq: [], history: [],
    summary: { catalogTotal: 16, controlsShown: 16, controlsMet: 12, deviceCount: null },
    ...over,
  } as never,
  lastEvaluatedAt: NOW, preview: false, partnerSlug: 'nw', orgSlug: 'acme',
});

describe('TrustSubprocessors', () => {
  it('renders nothing without subprocessors', () => {
    const { container } = render(<TrustSubprocessors {...props()} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('renders a table of name, purpose, location and an https website link', () => {
    render(<TrustSubprocessors {...props({ subprocessors: [
      { name: 'Acme EDR', purpose: 'Endpoint security', location: 'United States', websiteUrl: 'https://acme.example' },
      { name: 'Bare', purpose: 'Backup', location: null, websiteUrl: null },
    ] })} />);
    const table = screen.getByTestId('trust-subprocessors');
    expect(table).toHaveTextContent('Acme EDR');
    expect(table).toHaveTextContent('United States');
    const link = screen.getByRole('link', { name: /acme\.example/ });
    expect(link).toHaveAttribute('href', 'https://acme.example');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getAllByTestId('trust-subprocessor-row')).toHaveLength(2);
  });
  it('uses the page locale', () => {
    render(<TrustLocaleContext.Provider value="de-DE"><TrustSubprocessors {...props({ subprocessors: [{ name: 'A', purpose: 'P', location: null, websiteUrl: null }] })} /></TrustLocaleContext.Provider>);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Unterauftragsverarbeiter');
  });
  it('never emits a style attribute', () => {
    const { container } = render(<TrustSubprocessors {...props({ subprocessors: [{ name: 'A', purpose: 'P', location: 'X', websiteUrl: 'https://a.example' }] })} />);
    expect(container.querySelectorAll('[style]').length).toBe(0);
  });
});

describe('TrustFaq', () => {
  it('renders nothing without items', () => {
    const { container } = render(<TrustFaq {...props()} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('renders a <details> per item with the (server-sanitized) answer HTML', () => {
    const { container } = render(<TrustFaq {...props({ faq: [
      { question: 'Where is data stored?', answerHtml: '<p>In the <strong>US</strong>.</p>' },
      { question: 'Is it encrypted?', answerHtml: '<p>Yes</p>' },
    ] })} />);
    expect(container.querySelectorAll('details')).toHaveLength(2);
    expect(screen.getByText('Where is data stored?')).toBeInTheDocument();
    expect(container.querySelector('details strong')).toHaveTextContent('US');
    expect(container.querySelectorAll('[style]').length).toBe(0);
  });
});

describe('TrustHistory', () => {
  it('renders nothing when history is empty (showHistory off)', () => {
    const { container } = render(<TrustHistory {...props()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws the stored points plus the appended current point, with the approved caption', () => {
    render(<TrustHistory {...props({ history: [{ at: day(30), met: 10, shown: 16 }, { at: day(10), met: 11, shown: 16 }] })} />);
    expect(screen.getByTestId('trust-history')).toBeInTheDocument();
    const points = screen.getAllByTestId('trust-history-point');
    expect(points).toHaveLength(3);
    expect(points[2]).toHaveAttribute('data-met', '12'); // summary.controlsMet at lastEvaluatedAt
    expect(screen.getByTestId('trust-history')).toHaveTextContent('Controls met over the last 90 days. Each change is recorded when Breeze re-evaluates the page.');
  });

  it('clamps to 90 days: points older than the window collapse into the newest one, drawn at the window start', () => {
    render(<TrustHistory {...props({ history: [
      { at: day(200), met: 1, shown: 16 }, { at: day(120), met: 8, shown: 16 }, { at: day(5), met: 11, shown: 16 },
    ] })} />);
    const points = screen.getAllByTestId('trust-history-point');
    expect(points.map((p) => p.getAttribute('data-met'))).toEqual(['8', '11', '12']);
  });

  it('is pure SVG attributes: no style attribute anywhere', () => {
    const { container } = render(<TrustHistory {...props({ history: [{ at: day(30), met: 10, shown: 16 }] })} />);
    expect(container.querySelectorAll('[style]').length).toBe(0);
    expect(container.querySelector('svg')).toHaveAttribute('role', 'img');
  });
});
