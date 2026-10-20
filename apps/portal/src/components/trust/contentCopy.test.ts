import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '@breeze/shared';
import { copyParityProblems } from './trustCopy';
import { CONTENT_COPY } from './contentCopy';

describe('contentCopy', () => {
  it('has every locale with the same keys and no empty strings', () => {
    expect(copyParityProblems(CONTENT_COPY)).toEqual([]);
    expect(Object.keys(CONTENT_COPY).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it('non-English locales are not left as the English text', () => {
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === 'en') continue;
      expect(CONTENT_COPY[locale].historyCaption).not.toBe(CONTENT_COPY.en.historyCaption);
      expect(CONTENT_COPY[locale].faqHeading).not.toBe(CONTENT_COPY.en.faqHeading);
    }
  });

  it('the English history caption is the approved wording', () => {
    expect(CONTENT_COPY.en.historyCaption).toBe('Controls met over the last 90 days. Each change is recorded when Breeze re-evaluates the page.');
  });
});
