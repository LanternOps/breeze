import '@testing-library/jest-dom';
import { afterEach } from 'vitest';
import { i18n } from '@/lib/i18n';

// Locale is a process-wide singleton and the preference is persisted. Tests
// that intentionally switch language must not seed unrelated files in the
// same Vitest worker, regardless of file scheduling or worker count.
afterEach(async () => {
  try {
    window.localStorage.removeItem('breeze.locale');
  } catch {
    // Some storage-failure tests deliberately replace localStorage.
  }
  try {
    await i18n.changeLanguage('en');
  } catch {
    // Some navigation tests deliberately replace window.location with a
    // minimal assign/replace stub. i18next changes language before the
    // document-metadata listener observes the missing pathname.
  }
});
