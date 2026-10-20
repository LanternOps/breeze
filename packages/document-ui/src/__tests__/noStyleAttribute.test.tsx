import { render } from '@testing-library/react';
import { DocumentPaper } from '../DocumentPaper';

// W1c extends this to every exported component with every fixture.
function renderAll() {
  return (['classic', 'condensed'] as const).map(
    (theme) => render(<DocumentPaper theme={theme}>body</DocumentPaper>).container,
  );
}

it('renders no style attribute (CSP: the host nonces <style>, never style="")', () => {
  for (const container of renderAll()) {
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  }
});
