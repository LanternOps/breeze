import { render } from '@testing-library/react';
import { DocumentPaper, PACKAGE_PROBE_CLASS } from '../DocumentPaper';

it('stamps the root attributes the CSS and parity tests key on', () => {
  const { container } = render(<DocumentPaper theme="condensed">x</DocumentPaper>);
  const root = container.firstElementChild!;
  expect(root.hasAttribute('data-document-root')).toBe(true);
  expect(root.getAttribute('data-doc-theme')).toBe('condensed');
  expect(root.getAttribute('data-testid')).toBe('document-root');
  expect(root.className).toContain(PACKAGE_PROBE_CLASS);
});

it('honours an explicit testId and leads with the accent bar', () => {
  const { container } = render(<DocumentPaper theme="classic" testId="t">x</DocumentPaper>);
  const root = container.firstElementChild!;
  expect(root.getAttribute('data-testid')).toBe('t');
  expect(root.firstElementChild!.className).toContain('doc-accent-bg');
});
