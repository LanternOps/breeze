import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PartnerRegisterForm from './PartnerRegisterForm';

describe('PartnerRegisterForm test ids', () => {
  it('exposes stable data-testids for every field and the submit button', () => {
    render(<PartnerRegisterForm />);
    for (const id of [
      'register-company-name',
      'register-name',
      'register-email',
      'register-password',
      'register-confirm-password',
      'register-accept-terms',
      'register-submit',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });
});

describe('PartnerRegisterForm purchase section', () => {
  it('renders no purchase section without an offer or a wisp intent', () => {
    render(<PartnerRegisterForm signupIntent={{ intent: 'cloud' }} offer={null} />);
    expect(screen.queryByTestId('register-purchase-selection')).toBeNull();
  });
  it('keeps the wisp note with a null offer', () => {
    render(<PartnerRegisterForm signupIntent={{ intent: 'wisp' }} offer={null} />);
    expect(screen.getByTestId('register-wisp-note')).toBeInTheDocument();
  });
});
