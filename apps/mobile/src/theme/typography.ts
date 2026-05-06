import type { TextStyle } from 'react-native';

// Geist family. Weights are loaded via expo-font; family names below match
// the registration in App.tsx (next task).
export const fontFamily = {
  sans:        'Geist-Regular',
  sansMedium:  'Geist-Medium',
  sansSemiBold:'Geist-SemiBold',
  mono:        'GeistMono-Regular',
  monoMedium:  'GeistMono-Medium',
} as const;

type StyleStep = Pick<TextStyle, 'fontFamily' | 'fontSize' | 'lineHeight' | 'letterSpacing'>;

export const type = {
  display:   { fontFamily: fontFamily.sansSemiBold, fontSize: 32, lineHeight: 36, letterSpacing: -0.4 } satisfies StyleStep,
  title:     { fontFamily: fontFamily.sansSemiBold, fontSize: 22, lineHeight: 28, letterSpacing: -0.2 } satisfies StyleStep,
  bodyLg:    { fontFamily: fontFamily.sans,        fontSize: 17, lineHeight: 24 } satisfies StyleStep,
  body:      { fontFamily: fontFamily.sans,        fontSize: 16, lineHeight: 24 } satisfies StyleStep,
  bodyMd:    { fontFamily: fontFamily.sansMedium,  fontSize: 16, lineHeight: 24 } satisfies StyleStep,
  meta:      { fontFamily: fontFamily.sansMedium,  fontSize: 13, lineHeight: 18, letterSpacing: 0.1 } satisfies StyleStep,
  metaCaps:  { fontFamily: fontFamily.sansSemiBold,fontSize: 11, lineHeight: 14, letterSpacing: 1.0 } satisfies StyleStep,
  mono:      { fontFamily: fontFamily.mono,        fontSize: 14, lineHeight: 22 } satisfies StyleStep,
  monoMd:    { fontFamily: fontFamily.monoMedium,  fontSize: 14, lineHeight: 22 } satisfies StyleStep,
};
