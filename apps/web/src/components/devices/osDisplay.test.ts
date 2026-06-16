import { describe, expect, it } from 'vitest';

import { formatDeviceDetailOsVersion, formatDeviceOsVersion, formatDeviceSummaryOs } from './osDisplay';

describe('device OS display formatting', () => {
  it('leaves Windows OS versions untouched', () => {
    expect(
      formatDeviceOsVersion('windows', 'Microsoft Windows 11 Home 10.0.26200.8655 Build 26200.8655'),
    ).toBe('Microsoft Windows 11 Home 10.0.26200.8655 Build 26200.8655');
  });

  it('only treats Darwin as macOS when the OS type is macos', () => {
    expect(formatDeviceOsVersion('macos', 'darwin 26.5.1')).toBe('macOS 26.5.1');
    expect(formatDeviceOsVersion('macos', 'darwin')).toBe('macOS');
    expect(formatDeviceOsVersion('darwin', 'darwin 26.5.1')).toBe('darwin 26.5.1');
  });

  it('omits the redundant macOS label for detail OS version rows', () => {
    expect(formatDeviceDetailOsVersion('macos', 'darwin 26.5.1')).toBe('26.5.1');
    expect(formatDeviceDetailOsVersion('macos', 'macOS 26.5.1')).toBe('26.5.1');
  });

  it('capitalizes Linux distro names in OS versions', () => {
    expect(formatDeviceOsVersion('linux', 'raspbian 13.5')).toBe('Raspbian 13.5');
    expect(formatDeviceOsVersion('linux', 'bazzite 44')).toBe('Bazzite 44');
    expect(formatDeviceOsVersion('linux', 'debian 13.5')).toBe('Debian 13.5');
    expect(formatDeviceOsVersion('linux', 'almalinux 9.4')).toBe('AlmaLinux 9.4');
    expect(formatDeviceOsVersion('linux', 'amazon linux 2023')).toBe('Amazon Linux 2023');
    expect(formatDeviceOsVersion('linux', 'linux mint 22')).toBe('Linux Mint 22');
    expect(formatDeviceOsVersion('linux', 'linuxmint 22')).toBe('Linux Mint 22');
    expect(formatDeviceOsVersion('linux', 'cachyos 2025.06')).toBe('CachyOS 2025.06');
    expect(formatDeviceOsVersion('linux', 'elementary os 8')).toBe('elementary OS 8');
    expect(formatDeviceOsVersion('linux', 'kde neon 6')).toBe('KDE neon 6');
    expect(formatDeviceOsVersion('linux', 'nixos 24.11')).toBe('NixOS 24.11');
    expect(formatDeviceOsVersion('linux', 'oracle linux 9.5')).toBe('Oracle Linux 9.5');
    expect(formatDeviceOsVersion('linux', 'proxmox ve 8.3')).toBe('Proxmox VE 8.3');
    expect(formatDeviceOsVersion('linux', 'raspberry pi os 13')).toBe('Raspberry Pi OS 13');
    expect(formatDeviceOsVersion('linux', 'red hat enterprise linux 9.5')).toBe(
      'Red Hat Enterprise Linux 9.5',
    );
    expect(formatDeviceOsVersion('linux', 'rocky 9.4')).toBe('Rocky Linux 9.4');
    expect(formatDeviceOsVersion('linux', 'sles 15.6')).toBe('SLES 15.6');
    expect(formatDeviceOsVersion('linux', 'suse linux enterprise server 15.6')).toBe(
      'SUSE Linux Enterprise Server 15.6',
    );
    expect(formatDeviceOsVersion('linux', 'truenas scale 24.10')).toBe('TrueNAS SCALE 24.10');
    expect(formatDeviceOsVersion('linux', 'unraid 7.0')).toBe('Unraid 7.0');
    expect(formatDeviceOsVersion('linux', 'pop!_os 22.04')).toBe('Pop!_OS 22.04');
  });

  it('includes the OS type in the device summary when the version does not already name it', () => {
    expect(formatDeviceSummaryOs('linux', 'raspbian 13.5')).toBe('Linux Raspbian 13.5');
    expect(formatDeviceSummaryOs('macos', 'darwin 26.5.1')).toBe('macOS 26.5.1');
    expect(formatDeviceSummaryOs('windows', '11 Pro')).toBe('Windows 11 Pro');
  });

  it('does not duplicate OS family names in the device summary', () => {
    expect(formatDeviceSummaryOs('windows', 'Microsoft Windows 11 Pro')).toBe('Microsoft Windows 11 Pro');
    expect(formatDeviceSummaryOs('macos', 'Mac OS X 10.15.7')).toBe('Mac OS X 10.15.7');
    expect(formatDeviceSummaryOs('linux', 'almalinux 9.4')).toBe('AlmaLinux 9.4');
    expect(formatDeviceSummaryOs('linux', 'amazon linux 2023')).toBe('Amazon Linux 2023');
    expect(formatDeviceSummaryOs('linux', 'linux mint 22')).toBe('Linux Mint 22');
    expect(formatDeviceSummaryOs('linux', 'oracle linux 9.5')).toBe('Oracle Linux 9.5');
    expect(formatDeviceSummaryOs('linux', 'rocky 9.4')).toBe('Rocky Linux 9.4');
    expect(formatDeviceSummaryOs('linux', 'suse linux enterprise server 15.6')).toBe(
      'SUSE Linux Enterprise Server 15.6',
    );
  });
});
