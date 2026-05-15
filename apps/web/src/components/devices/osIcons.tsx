// Inline SVGs for Windows + Linux brand glyphs (paths adapted from
// simple-icons CC0); macOS reuses lucide-react `Apple`. Two glyphs do
// not justify a new icon-package dependency.

import type { SVGProps } from 'react';
import { Apple } from 'lucide-react';

export type OSIconProps = SVGProps<SVGSVGElement> & {
  className?: string;
  title?: string;
};

export function WindowsIcon({ title = 'Windows', className, ...rest }: OSIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label={title}
      role="img"
      {...rest}
    >
      <title>{title}</title>
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
    </svg>
  );
}

export function MacOSIcon({ title = 'macOS', className, ...rest }: OSIconProps) {
  return <Apple className={className} aria-label={title}>
    <title>{title}</title>
  </Apple>;
}

export function LinuxIcon({ title = 'Linux', className, ...rest }: OSIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label={title}
      role="img"
      {...rest}
    >
      <title>{title}</title>
      <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.077 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68a.93.93 0 00-.105.482c.012.157.043.34.058.527.027.476-.054.978-.142 1.341-.196.62.057.93.347 1.073.13.041.281.07.408.07.348 0 .627-.105.93-.302.4-.288.65-.776.787-1.357.18-.557.358-.92.567-1.16.18-.207.348-.336.566-.341.218-.005.357.119.553.293.197.175.41.434.71.643.214.155.535.27.953.27.348 0 .68-.107.974-.286.293-.18.516-.453.633-.804.116-.349.183-.654.252-.91.07-.255.13-.493.297-.66.21-.197.484-.252.866-.252.382 0 .746.055 1.116.252.37.197.683.567.992 1.124.31.557.516 1.265.516 2.117 0 .478-.073.965-.213 1.42-.14.456-.348.882-.616 1.265-.27.382-.605.71-1.012.957a3.073 3.073 0 01-1.62.42c-1.16 0-2.115-.443-2.857-1.273-.74-.83-1.166-1.92-1.166-3.158 0-.628.115-1.244.34-1.808.226-.564.566-1.072.99-1.488.426-.416.93-.74 1.484-.957.554-.218 1.154-.328 1.781-.328z" />
    </svg>
  );
}

import { Monitor } from 'lucide-react';
export function OSIcon({ os, className }: { os: 'windows' | 'macos' | 'linux'; className?: string }) {
  if (os === 'windows') return <WindowsIcon className={className} />;
  if (os === 'macos') return <MacOSIcon className={className} />;
  if (os === 'linux') return <LinuxIcon className={className} />;
  return <Monitor className={className} />;
}
