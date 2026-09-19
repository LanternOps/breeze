import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import ScriptSecurityReview from './ScriptSecurityReview';

// #5129. The acknowledgement UI is where a human accepts a named risk, so the
// assertions here are about WHICH risks are offered and what gets emitted —
// not about styling.

const HKLM = 'PowerShell HKLM modification';
const SCHTASKS = 'scheduled task creation';

const hklmLine = "Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Contoso' -Name Enabled -Value 1";
const schtasksLine = 'schtasks /create /tn Nightly /tr C:\\x.exe /sc daily';

const checkboxFor = (description: string) =>
  screen.getByTestId(`script-security-ack-${description}`) as HTMLInputElement;

describe('ScriptSecurityReview', () => {
  it('renders nothing for a script that matches no strict pattern', () => {
    const { container } = render(
      <ScriptSecurityReview content='Write-Output "hello"' value={[]} onChange={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for empty content', () => {
    const { container } = render(
      <ScriptSecurityReview content="" value={[]} onChange={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('surfaces a matched pattern with its explanation', () => {
    render(<ScriptSecurityReview content={hklmLine} value={[]} onChange={vi.fn()} />);

    expect(screen.getByTestId('script-security-review')).toBeInTheDocument();
    expect(checkboxFor(HKLM).checked).toBe(false);
    // The explanation is what makes this an informed decision rather than a
    // rubber stamp, so its presence is part of the contract.
    expect(screen.getByText(/machine-wide registry value/i)).toBeInTheDocument();
  });

  it('never offers a BASIC-level pattern for acknowledgement', () => {
    // `rm -rf /` and Format-Volume are unconditional blocks with no override
    // path. If they ever appear here, the UI is promising something the agent
    // will not honour.
    const { container } = render(
      <ScriptSecurityReview content={'rm -rf /\nFormat-Volume -DriveLetter D'} value={[]} onChange={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a matched-and-acknowledged pattern as checked, with no warning', () => {
    render(<ScriptSecurityReview content={hklmLine} value={[HKLM]} onChange={vi.fn()} />);

    expect(checkboxFor(HKLM).checked).toBe(true);
    expect(screen.queryByText(/will refuse to run/i)).not.toBeInTheDocument();
  });

  it('warns for each pattern that is still unacknowledged', () => {
    render(
      <ScriptSecurityReview
        content={`${hklmLine}\n${schtasksLine}`}
        value={[HKLM]}
        onChange={vi.fn()}
      />,
    );

    expect(checkboxFor(HKLM).checked).toBe(true);
    expect(checkboxFor(SCHTASKS).checked).toBe(false);
    expect(screen.getAllByText(/will refuse to run/i)).toHaveLength(1);
  });

  it('emits the description verbatim when a pattern is acknowledged', () => {
    // Verbatim matters: the agent compares against ITS own description string,
    // so any rewriting here silently stops the acknowledgement working.
    const onChange = vi.fn();
    render(<ScriptSecurityReview content={hklmLine} value={[]} onChange={onChange} />);

    fireEvent.click(checkboxFor(HKLM));

    expect(onChange).toHaveBeenCalledWith([HKLM]);
  });

  it('emits the remaining descriptions when one is un-acknowledged', () => {
    const onChange = vi.fn();
    render(
      <ScriptSecurityReview
        content={`${hklmLine}\n${schtasksLine}`}
        value={[HKLM, SCHTASKS]}
        onChange={onChange}
      />,
    );

    fireEvent.click(checkboxFor(SCHTASKS));

    expect(onChange).toHaveBeenCalledWith([HKLM]);
  });

  it('drops a stale acknowledgement for a pattern the content no longer contains', () => {
    // The script used to create a scheduled task; that line is gone. Toggling
    // an unrelated checkbox must not carry the dead approval back to the
    // server. (The server applies the same intersection, so this is
    // defence in depth — but a UI that shows a stale approval as live is its
    // own bug.)
    const onChange = vi.fn();
    render(<ScriptSecurityReview content={hklmLine} value={[SCHTASKS]} onChange={onChange} />);

    expect(screen.queryByTestId(`script-security-ack-${SCHTASKS}`)).not.toBeInTheDocument();

    fireEvent.click(checkboxFor(HKLM));

    expect(onChange).toHaveBeenCalledWith([HKLM]);
  });

  it('does not emit when disabled', () => {
    const onChange = vi.fn();
    render(
      <ScriptSecurityReview content={hklmLine} value={[]} onChange={onChange} disabled />,
    );

    expect(checkboxFor(HKLM).disabled).toBe(true);
    fireEvent.click(checkboxFor(HKLM));
    expect(onChange).not.toHaveBeenCalled();
  });
});
