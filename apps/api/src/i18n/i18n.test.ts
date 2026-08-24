import { describe, it, expect } from 'vitest';
import { tApi } from './index';

describe('tApi', () => {
  it('translates an email key in English', () => {
    expect(tApi('en', 'emails:passwordReset.subject')).toBe('Reset your password');
  });

  it('translates an email key in pt-BR', () => {
    expect(tApi('pt-BR', 'emails:passwordReset.subject')).toBe('Redefinir sua senha');
  });

  it('translates a PDF key in English', () => {
    expect(tApi('en', 'pdf:invoice.title')).toBe('INVOICE');
  });

  it('translates a PDF key in pt-BR', () => {
    expect(tApi('pt-BR', 'pdf:invoice.title')).toBe('FATURA');
  });

  it('translates a notification key in English', () => {
    expect(tApi('en', 'notifications:severity.critical')).toBe('Critical');
  });

  it('translates a notification key in pt-BR', () => {
    expect(tApi('pt-BR', 'notifications:severity.critical')).toBe('Crítico');
  });

  it('interpolates variables correctly', () => {
    const result = tApi('en', 'emails:invoice.subject', {
      invoiceNumber: '#42',
      partnerName: 'Acme MSP',
    });
    expect(result).toBe('Invoice #42 from Acme MSP');
  });

  it('interpolates variables correctly in pt-BR', () => {
    const result = tApi('pt-BR', 'emails:invoice.subject', {
      invoiceNumber: '#42',
      partnerName: 'Acme MSP',
    });
    expect(result).toBe('Fatura #42 de Acme MSP');
  });

  it('falls back to English for a locale with no translation file', () => {
    // 'de-DE' has no locale file — falls back to 'en'
    const result = tApi('de-DE', 'emails:passwordReset.subject');
    expect(result).toBe('Reset your password');
  });

  it('concurrent calls with different locales return the correct locale each time', async () => {
    // Run two tApi calls "in parallel" — they must not interfere (no global
    // language state is mutated between calls).
    const [enResult, ptBrResult] = await Promise.all([
      Promise.resolve(tApi('en', 'pdf:invoice.title')),
      Promise.resolve(tApi('pt-BR', 'pdf:invoice.title')),
    ]);
    expect(enResult).toBe('INVOICE');
    expect(ptBrResult).toBe('FATURA');
  });
});
