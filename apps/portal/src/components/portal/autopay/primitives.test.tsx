// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, Notice } from '../ui';
import { AutopayShell } from './AutopayShell';
import { AuthorizationBox } from './AuthorizationBox';
import { MethodChoice } from './MethodChoice';
import { StatePanel } from './StatePanel';
import { SummaryList } from './SummaryList';
import { LinkStatePanel } from './LinkStatePanel';

const TEXT = 'I authorize Example MSP to save this card and use it to pay future invoices automatically. Each invoice is charged on its due date.';

describe('Notice', () => {
  it('announces failures as alerts and everything else as status, with AA-safe text', () => {
    const { rerender } = render(<Notice tone="destructive" title="We couldn't stop automatic payments">Try again.</Notice>);
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't stop automatic payments");
    expect(screen.getByRole('alert').className).toContain('text-destructive-on-tint');
    rerender(<Notice tone="warning" title="One more step" />);
    expect(screen.getByRole('status').className).toContain('text-warning-on-tint');
  });
});

describe('AuthorizationBox', () => {
  it('shows the full hashed text verbatim and ties it to the checkbox', () => {
    const onChange = vi.fn();
    render(<AuthorizationBox id="auth" text={TEXT} checked={false} onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'I agree to this authorization' });
    const describedBy = box.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)!.textContent).toBe(TEXT);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it('is never collapsed or scrolled: no details/summary and no overflow container', () => {
    const { container } = render(<AuthorizationBox id="auth" text={TEXT} checked={false} onChange={() => {}} />);
    expect(container.querySelector('details')).toBeNull();
    expect(container.innerHTML).not.toMatch(/overflow-(y-)?(auto|scroll)|max-h-/);
  });
  it('says so when the text changed under a ticked box', () => {
    render(<AuthorizationBox id="auth" text={TEXT} checked={false} onChange={() => {}} changedNotice />);
    expect(screen.getByText('The authorization changed. Please read it and agree again.')).toBeInTheDocument();
  });
});

describe('MethodChoice', () => {
  const options = [
    { value: 'us_bank_account', name: 'Bank account', fee: '$1.00 fee', detail: 'Recommended by Example MSP' },
    { value: 'card', name: 'Card', fee: 'Credit cards: up to 3% fee', detail: 'Debit and prepaid cards: no fee' },
  ];
  it('is a labelled radio group whose rows name the method and its fee', () => {
    const onChange = vi.fn();
    render(<MethodChoice legend="Choose how to pay" name="m" options={options} value="us_bank_account" onChange={onChange} />);
    expect(screen.getByRole('group', { name: 'Choose how to pay' })).toBeInTheDocument();
    const card = screen.getByRole('radio', { name: /Card/ });
    expect(screen.getByRole('radio', { name: /Bank account/ })).toBeChecked();
    expect(screen.getByText('Credit cards: up to 3% fee')).toBeInTheDocument();
    fireEvent.click(card);
    expect(onChange).toHaveBeenCalledWith('card');
  });
  it('renders a single method as a plain row, not a lone radio', () => {
    render(<MethodChoice legend="Choose how to pay" name="m" options={[options[1]!]} value="card" onChange={() => {}} />);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('Card')).toBeInTheDocument();
    expect(screen.getByText('Credit cards: up to 3% fee')).toBeInTheDocument();
  });
});

describe('StatePanel', () => {
  it('moves focus to its heading so the new state is announced', () => {
    render(<StatePanel title="Automatic payments are on" mark={{ tone: 'success', label: 'On' }}>Done.</StatePanel>);
    const heading = screen.getByRole('heading', { level: 1, name: 'Automatic payments are on' });
    expect(document.activeElement).toBe(heading);
    expect(heading.className).toContain('font-display');
    expect(screen.getByText('On')).toBeInTheDocument();
  });
  it('renders actions as real buttons or links', () => {
    const onClick = vi.fn();
    render(<StatePanel title="Setup didn't finish" headingLevel={2}
      primary={{ label: 'Try again', onClick }} secondary={{ label: 'Email Example MSP', href: 'mailto:billing@msp.example' }} />);
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Email Example MSP' })).toHaveAttribute('href', 'mailto:billing@msp.example');
  });
});

describe('SummaryList', () => {
  it('is a description list of label/value pairs', () => {
    render(<SummaryList rows={[{ label: 'Invoice', value: 'INV-1' }, { label: 'Amount', value: '$50.00', figure: true }]} />);
    expect(screen.getByText('Invoice').tagName).toBe('DT');
    expect(screen.getByText('$50.00').tagName).toBe('DD');
    expect(screen.getByText('$50.00').className).toContain('text-figures');
  });
});

describe('AutopayShell', () => {
  it('names the MSP, offers its billing email and never renders a nested <main>', () => {
    const { container } = render(<AutopayShell partnerName="Example MSP" supportEmail="billing@msp.example"><p>Body</p></AutopayShell>);
    expect(container.querySelector('main')).toBeNull();
    expect(screen.getByText('Example MSP')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'billing@msp.example' })).toHaveAttribute('href', 'mailto:billing@msp.example');
    expect(screen.getByText(/processed securely by Stripe/)).toBeInTheDocument();
  });
  it('uses the logo when there is one', () => {
    render(<AutopayShell partnerName="Example MSP" logoUrl="https://cdn.example/logo.png"><p>Body</p></AutopayShell>);
    expect(screen.getByRole('img', { name: 'Example MSP' })).toHaveAttribute('src', 'https://cdn.example/logo.png');
  });
});

describe('LinkStatePanel', () => {
  it.each([
    [{ code: 'link_invalid' }, "This link doesn't work"],
    [{ code: 'link_expired', partnerName: 'Example MSP' }, 'This link has expired'],
    [{ code: 'link_replaced', partnerName: 'Example MSP' }, 'This link was replaced'],
    [{ code: 'link_used', partnerName: 'Example MSP', enrollmentStatus: 'active' }, "You're already set up"],
    [{ code: 'link_used', partnerName: 'Example MSP', enrollmentStatus: 'cancelled' }, 'Automatic payments are off'],
    [{ code: 'autopay_not_enabled', partnerName: 'Example MSP' }, "Automatic payment setup isn't available right now"],
  ] as const)('%j explains itself', (failure, title) => {
    render(<LinkStatePanel failure={failure} purpose="enroll" />);
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/not found/i);
  });
  it('an unknown link names no MSP', () => {
    render(<LinkStatePanel failure={{ code: 'link_invalid' }} purpose="enroll" />);
    expect(document.body.textContent).not.toContain('Example MSP');
  });
});

// V-23: on a phone (or the 320px invoice rail) the label sits over the value, so
// "Visa credit card ending in 4242" never wraps beside a 40% label column.
describe('SummaryList layout', () => {
  it('stacks label over value until its own container is 24rem wide', () => {
    const { container } = render(<SummaryList rows={[{ label: 'Payment method', value: 'Visa credit card ending in 4242' }]} />);
    const list = container.querySelector('dl')!;
    expect(list).toHaveClass('@container');
    const row = list.firstElementChild!;
    expect(row).toHaveClass('grid-cols-1', '@sm:grid-cols-[9rem_1fr]');
    expect(row.className).not.toMatch(/min-\[360px\]/);
  });
});

// V-24: every button is the same height side by side, and a 44px target on phones.
describe('buttons', () => {
  it.each([['primary', BTN_PRIMARY], ['secondary', BTN_SECONDARY], ['danger', BTN_DANGER]])('%s', (_name, cls) => {
    expect(cls).toContain('border');
    expect(cls).toContain('min-h-11');
    expect(cls).toContain('sm:min-h-9');
  });
});
