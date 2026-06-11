export * from './tokens';
export * from './typography';

import { useColorScheme } from 'react-native';
import { palette } from './tokens';

// Approval mode is dark-canonical. This hook returns the right palette half
// for the current scheme but consumers can pass `force: 'dark' | 'light'`
// to lock the scheme — approval mode always passes 'dark'.
export function useApprovalTheme(force?: 'dark' | 'light') {
  const scheme = useColorScheme();
  const mode = force ?? (scheme === 'light' ? 'light' : 'dark');
  return {
    mode,
    bg0: palette[mode].bg0,
    bg1: palette[mode].bg1,
    bg2: palette[mode].bg2,
    bg3: palette[mode].bg3,
    border: palette[mode].border,
    textHi: palette[mode].textHi,
    textMd: palette[mode].textMd,
    textLo: palette[mode].textLo,
    brand: palette.brand.base,
    approve: palette.approve.base,
    deny: palette.deny.base,
    warning: palette.warning.base,
  };
}
