import '@/lib/i18n';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ServicesManager, { type WindowsService } from './ServicesManager';
import ProcessManager, { type Process } from './ProcessManager';

afterEach(cleanup);

const services: WindowsService[] = [
  { name: 'Affiniti_Device_manager', displayName: 'Device Manager', status: 'Running', startupType: 'Automatic', account: 'LocalSystem' },
  { name: 'Spooler', displayName: 'Print Spooler', status: 'Stopped', startupType: 'Manual', account: 'LocalSystem' },
];
const processes: Process[] = [
  { pid: 10, name: 'chrome.exe', user: 'u', cpuPercent: 1, memoryMb: 10, status: 'running', commandLine: 'c' },
  { pid: 11, name: 'a b&c.exe', user: 'u', cpuPercent: 1, memoryMb: 10, status: 'running', commandLine: 'c' },
];

describe('Monitor this row action (#10927)', () => {
  it('services: one link per row, prefilled with the service name', () => {
    render(<ServicesManager deviceId="d1" services={services} />);
    const links = screen.getAllByTestId('monitor-this-service');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('/alerts/monitors/new#kind=service&serviceName=Affiniti_Device_manager');
  });

  it('processes: one link per row, name is URL-encoded', () => {
    render(<ProcessManager deviceId="d1" processes={processes} />);
    const links = screen.getAllByTestId('monitor-this-process');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('/alerts/monitors/new#kind=process&processName=chrome.exe');
    expect(links[1].getAttribute('href')).toBe('/alerts/monitors/new#kind=process&processName=a%20b%26c.exe');
  });

  it('clicking the link does not expand the row', () => {
    render(<ServicesManager deviceId="d1" services={services} />);
    const link = screen.getAllByTestId('monitor-this-service')[0];
    link.addEventListener('click', e => e.preventDefault());
    fireEvent.click(link);
    expect(screen.queryByText(/dependencies/i)).toBeNull();
  });
});
