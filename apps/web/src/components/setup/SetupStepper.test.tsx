import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SetupStepper from './SetupStepper';

const STEPS = [
  { label: 'Purpose', description: 'Mode, kind and name' },
  { label: 'What it does', description: 'Triggers and capabilities' },
  { label: 'Safety', description: 'Limits and oversight' },
];

describe('SetupStepper', () => {
  it('defaults the accessible name to the auth setup wizard string when ariaLabel is omitted', () => {
    render(<SetupStepper steps={STEPS} currentStep={0} />);
    expect(screen.getByRole('navigation', { name: 'Setup progress' })).toBeInTheDocument();
  });

  it('uses a caller-supplied ariaLabel instead of the auth default', () => {
    render(<SetupStepper steps={STEPS} currentStep={0} ariaLabel="New agent steps" />);
    expect(screen.getByRole('navigation', { name: 'New agent steps' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Setup progress' })).toBeNull();
  });

  it('renders horizontally by default, without step descriptions', () => {
    render(<SetupStepper steps={STEPS} currentStep={1} ariaLabel="Steps" />);
    expect(screen.getByText('Purpose')).toBeInTheDocument();
    expect(screen.queryByText('Mode, kind and name')).toBeNull();
  });

  it('renders vertically with a description under each step label when orientation="vertical"', () => {
    render(<SetupStepper steps={STEPS} currentStep={1} ariaLabel="Steps" orientation="vertical" />);
    expect(screen.getByTestId('setup-stepper-vertical')).toBeInTheDocument();
    expect(screen.getByText('Mode, kind and name')).toBeInTheDocument();
    expect(screen.getByText('Triggers and capabilities')).toBeInTheDocument();
    expect(screen.getByText('Limits and oversight')).toBeInTheDocument();
  });

  it('lets a completed step be clicked, but not the current or an upcoming one', () => {
    const onStepClick = vi.fn();
    render(<SetupStepper steps={STEPS} currentStep={1} ariaLabel="Steps" orientation="vertical" onStepClick={onStepClick} />);

    fireEvent.click(screen.getByTestId('setup-stepper-step-0'));
    expect(onStepClick).toHaveBeenCalledWith(0);

    fireEvent.click(screen.getByTestId('setup-stepper-step-1'));
    fireEvent.click(screen.getByTestId('setup-stepper-step-2'));
    expect(onStepClick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('setup-stepper-step-1')).toBeDisabled();
    expect(screen.getByTestId('setup-stepper-step-2')).toBeDisabled();
  });

  it('marks the current step with aria-current="step" only in the vertical layout', () => {
    render(<SetupStepper steps={STEPS} currentStep={2} ariaLabel="Steps" orientation="vertical" />);
    expect(screen.getByTestId('setup-stepper-step-2')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('setup-stepper-step-0')).not.toHaveAttribute('aria-current');
  });
});
