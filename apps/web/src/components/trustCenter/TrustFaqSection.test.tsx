// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const api = vi.hoisted(() => ({ getTrustFaq: vi.fn(), putTrustFaq: vi.fn() }));
vi.mock('@/lib/api/trustPageContent', () => api);
vi.mock('@/components/common/RichTextEditor', () => ({
  default: ({ value, onChange, testId }: { value: string; onChange: (h: string) => void; testId: string }) => (
    <textarea data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
import TrustFaqSection from './TrustFaqSection';

const orgFetch = vi.fn() as never;
const mount = (canWrite = true) => {
  const onReload = vi.fn(async () => {});
  render(<TrustFaqSection orgId="o1" orgFetch={orgFetch} state={{ page: { publicationRevision: 4 } } as never} canWrite={canWrite} onReload={onReload} />);
  return onReload;
};

describe('TrustFaqSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getTrustFaq.mockResolvedValue({ items: [{ question: 'Where is data stored?', answerHtml: '<p>US</p>' }], publicationRevision: 4 });
    api.putTrustFaq.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
  });

  it('loads existing items, adds one, and Save sends expectedRevision with the whole list', async () => {
    const onReload = mount();
    expect(await screen.findByTestId('trust-faq-question-0')).toHaveValue('Where is data stored?');
    fireEvent.click(screen.getByTestId('trust-faq-add'));
    fireEvent.change(screen.getByTestId('trust-faq-question-1'), { target: { value: 'Is data encrypted?' } });
    fireEvent.change(screen.getByTestId('trust-faq-answer-1'), { target: { value: '<p>Yes</p>' } });
    fireEvent.click(screen.getByTestId('trust-faq-save'));
    await waitFor(() => expect(api.putTrustFaq).toHaveBeenCalledWith(orgFetch, 'o1', 4, [
      { question: 'Where is data stored?', answerHtml: '<p>US</p>' },
      { question: 'Is data encrypted?', answerHtml: '<p>Yes</p>' },
    ]));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it('reorders and removes items', async () => {
    mount();
    await screen.findByTestId('trust-faq-question-0');
    fireEvent.click(screen.getByTestId('trust-faq-add'));
    fireEvent.change(screen.getByTestId('trust-faq-question-1'), { target: { value: 'Second question' } });
    fireEvent.click(screen.getByTestId('trust-faq-up-1'));
    expect(screen.getByTestId('trust-faq-question-0')).toHaveValue('Second question');
    fireEvent.click(screen.getByTestId('trust-faq-remove-0'));
    expect(screen.getByTestId('trust-faq-question-0')).toHaveValue('Where is data stored?');
  });

  it('blocks Save on a question shorter than 5 characters or an answer over the raw cap', async () => {
    mount();
    await screen.findByTestId('trust-faq-question-0');
    fireEvent.change(screen.getByTestId('trust-faq-question-0'), { target: { value: 'abcd' } });
    expect(screen.getByTestId('trust-faq-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('trust-faq-question-0'), { target: { value: 'abcde' } });
    expect(screen.getByTestId('trust-faq-save')).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('trust-faq-answer-0'), { target: { value: 'x'.repeat(2001) } });
    expect(screen.getByTestId('trust-faq-save')).toBeDisabled();
  });

  it('is read-only without write permission', async () => {
    mount(false);
    expect(await screen.findByTestId('trust-faq-question-0')).toBeDisabled();
    expect(screen.getByTestId('trust-faq-save')).toBeDisabled();
  });

  it('a failed load never lets Add or Save run (a replace-all Save would wipe the saved FAQ)', async () => {
    api.getTrustFaq.mockRejectedValue(new Error('boom'));
    mount();
    await screen.findByTestId('trust-faq-load-error');
    expect(screen.getByTestId('trust-faq-add')).toBeDisabled();
    expect(screen.getByTestId('trust-faq-save')).toBeDisabled();
  });

  it('Save sends the revision the list was loaded at', async () => {
    const onReload = vi.fn(async () => {});
    const view = (rev: number) => <TrustFaqSection orgId="o1" orgFetch={orgFetch} state={{ page: { publicationRevision: rev } } as never} canWrite onReload={onReload} />;
    const utils = render(view(4));
    await screen.findByTestId('trust-faq-question-0');
    fireEvent.change(screen.getByTestId('trust-faq-question-0'), { target: { value: 'Edited question' } });
    utils.rerender(view(6));
    fireEvent.click(screen.getByTestId('trust-faq-save'));
    await waitFor(() => expect(api.putTrustFaq).toHaveBeenCalledWith(orgFetch, 'o1', 4, expect.any(Array)));
  });
});
