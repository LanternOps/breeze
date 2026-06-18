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
