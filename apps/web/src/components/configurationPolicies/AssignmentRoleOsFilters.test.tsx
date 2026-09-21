import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';
import { DEVICE_ROLES } from '@/lib/deviceRoles';
import {
  AssignmentFilterBadges,
  AssignmentRoleOsFilters,
  assignmentFilterPayload,
} from './AssignmentRoleOsFilters';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('assignmentFilterPayload', () => {
  it('omits empty arrays', () => {
    expect(assignmentFilterPayload([], [])).toEqual({});
  });

  it('includes only roleFilter when roles are set', () => {
    expect(assignmentFilterPayload(['server'], [])).toEqual({ roleFilter: ['server'] });
  });

  it('includes only osFilter when OS values are set', () => {
    expect(assignmentFilterPayload([], ['windows'])).toEqual({ osFilter: ['windows'] });
  });
});

describe('AssignmentRoleOsFilters', () => {
  it('renders a button per device role and OS option', () => {
    render(
      <AssignmentRoleOsFilters
        roleFilter={[]}
        osFilter={[]}
        onRoleFilterChange={() => {}}
        onOsFilterChange={() => {}}
      />,
    );

    expect(screen.getByText('Role Filter')).toBeInTheDocument();
    expect(screen.getByText('OS Filter')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Workstation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Server' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Windows' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'macOS' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Linux' })).toBeInTheDocument();
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(DEVICE_ROLES.length + 3);
  });

  it('toggles Workstation on then off', () => {
    const onRoleFilterChange = vi.fn();
    const { rerender } = render(
      <AssignmentRoleOsFilters
        roleFilter={[]}
        osFilter={[]}
        onRoleFilterChange={onRoleFilterChange}
        onOsFilterChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Workstation' }));
    expect(onRoleFilterChange).toHaveBeenCalledWith(['workstation']);

    rerender(
      <AssignmentRoleOsFilters
        roleFilter={['workstation']}
        osFilter={[]}
        onRoleFilterChange={onRoleFilterChange}
        onOsFilterChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Workstation' }));
    expect(onRoleFilterChange).toHaveBeenLastCalledWith([]);
  });

  it('shows empty-state copy when nothing is selected', () => {
    render(
      <AssignmentRoleOsFilters
        roleFilter={[]}
        osFilter={[]}
        onRoleFilterChange={() => {}}
        onOsFilterChange={() => {}}
      />,
    );

    expect(
      screen.getByText('No restriction - applies to all device roles'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No restriction - applies to all operating systems'),
    ).toBeInTheDocument();
  });
});

describe('AssignmentFilterBadges', () => {
  it('shows All devices when both filters are empty', () => {
    render(<AssignmentFilterBadges roleFilter={[]} osFilter={[]} />);
    expect(screen.getByText('All devices')).toBeInTheDocument();
  });

  it('shows All devices when both filters are null', () => {
    render(<AssignmentFilterBadges roleFilter={null} osFilter={null} />);
    expect(screen.getByText('All devices')).toBeInTheDocument();
  });

  it('shows a Server badge for a role filter', () => {
    render(<AssignmentFilterBadges roleFilter={['server']} osFilter={null} />);
    expect(screen.getByText('Server')).toBeInTheDocument();
    expect(screen.queryByText('All devices')).not.toBeInTheDocument();
  });
});
