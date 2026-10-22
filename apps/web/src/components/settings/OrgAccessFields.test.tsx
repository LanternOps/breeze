import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import OrgAccessFields, { type OrgAccessLevel } from './OrgAccessFields';

// #9602: picking an organization closed the list and then re-focused the
// search input, whose onFocus re-opened it in the same update. The open list
// (absolutely positioned) sat over the dialog footer, so the next click meant
// for "Send Invite" landed on an organization row and granted it.

const ORGS = [
  { id: 'org-a', name: 'Acme Dental' },
  { id: 'org-b', name: 'Brightside Law' },
  { id: 'org-c', name: 'Lakeshore Legal' },
];

function Harness({ initialIds = [] as string[] }) {
  const [access, setAccess] = useState<OrgAccessLevel>('selected');
  const [ids, setIds] = useState<string[]>(initialIds);
  return (
    <div>
      <OrgAccessFields
        idPrefix="t"
        orgAccess={access}
        orgIds={ids}
        organizations={ORGS}
        onChange={(a, next) => {
          setAccess(a);
          setIds(next);
        }}
      />
      <output data-testid="ids">{ids.join(',')}</output>
    </div>
  );
}

const search = () => screen.getByPlaceholderText(/search organizations/i);
const listOpen = () => screen.queryByTestId('t-org-options') !== null;

describe('OrgAccessFields organization picker (#9602)', () => {
  it('closes the list after a pick and keeps focus in the search input', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(search());
    expect(listOpen()).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Brightside Law' }));

    expect(screen.getByTestId('ids').textContent).toBe('org-b');
    expect(listOpen()).toBe(false);
    expect(document.activeElement).toBe(search());
  });

  it('re-opens on click, typing or ArrowDown after a pick', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(search());
    await user.click(screen.getByRole('button', { name: 'Acme Dental' }));
    expect(listOpen()).toBe(false);

    await user.click(search());
    expect(listOpen()).toBe(true);

    await user.keyboard('{Escape}');
    expect(listOpen()).toBe(false);
    await user.keyboard('{ArrowDown}');
    expect(listOpen()).toBe(true);

    await user.keyboard('{Escape}');
    await user.type(search(), 'lake');
    expect(listOpen()).toBe(true);
    expect(screen.getByRole('button', { name: 'Lakeshore Legal' })).toBeTruthy();
  });

  it('closes the list on Escape without bubbling to an enclosing dialog', async () => {
    const user = userEvent.setup();
    let bubbled = 0;
    render(
      <div onKeyDown={e => { if (e.key === 'Escape') bubbled += 1; }}>
        <Harness />
      </div>
    );

    await user.click(search());
    expect(listOpen()).toBe(true);
    await user.keyboard('{Escape}');
    expect(listOpen()).toBe(false);
    expect(bubbled).toBe(0);

    // With the list already closed, Escape is the dialog's to handle.
    await user.keyboard('{Escape}');
    expect(bubbled).toBe(1);
  });

  it('closes the list on Escape from a focused option, without closing the dialog', async () => {
    const user = userEvent.setup();
    let bubbled = 0;
    render(
      <div onKeyDown={e => { if (e.key === 'Escape') bubbled += 1; }}>
        <Harness />
      </div>
    );

    await user.click(search());
    screen.getByRole('button', { name: 'Acme Dental' }).focus();
    await user.keyboard('{Escape}');
    expect(listOpen()).toBe(false);
    expect(bubbled).toBe(0);
  });

  it('does not open on a programmatic or tab focus alone', () => {
    render(<Harness />);
    fireEvent.focus(search());
    expect(listOpen()).toBe(false);
  });

  it('renders the list in the document flow, not as an overlay over the dialog footer', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(search());
    const list = screen.getByTestId('t-org-options');
    expect(list.className).not.toMatch(/\babsolute\b/);
  });
});
