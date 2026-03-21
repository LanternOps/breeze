// Declare process.env for React Native environment variables
declare global {
  const process: {
    env: {
      EXPO_PUBLIC_API_URL?: string;
      NODE_ENV?: string;
      [key: string]: string | undefined;
    };
  };
}

// Fix react-native-paper types for React 19
// Paper 5.x's component types use React.ComponentProps<typeof NativeX> which
// React 19's stricter JSX types don't propagate correctly (verified at 5.15).
// TODO: Remove when react-native-paper ships React 19-compatible types.
declare module 'react-native-paper' {
  import type { TextProps as RNTextProps, TextInputProps as RNTextInputProps, StyleProp, TextStyle, ViewStyle } from 'react-native';
  import type { ReactNode, RefAttributes } from 'react';

  // Paper Text: merges RN Text props back in (numberOfLines, etc.)
  // Note: variant is typed as string rather than the precise VariantProp union
  // because this override replaces Paper's full type. Accept loss of variant
  // autocomplete to fix JSX prop propagation errors.
  const Text: React.FC<RNTextProps & { variant?: string; theme?: unknown; children?: ReactNode }>;

  // Paper TextInput: merges RN TextInput props back in (secureTextEntry, keyboardType, etc.)
  const TextInput: React.ForwardRefExoticComponent<
    RNTextInputProps & {
      mode?: 'flat' | 'outlined';
      label?: string | ReactNode;
      left?: ReactNode;
      right?: ReactNode;
      disabled?: boolean;
      error?: boolean;
      theme?: unknown;
      underlineColor?: string;
      activeUnderlineColor?: string;
      outlineColor?: string;
      activeOutlineColor?: string;
      contentStyle?: StyleProp<TextStyle>;
      outlineStyle?: StyleProp<ViewStyle>;
      underlineStyle?: StyleProp<ViewStyle>;
    } & RefAttributes<{ focus: () => void; clear: () => void; blur: () => void; isFocused: () => boolean }>
  > & {
    Icon: React.FC<{ icon: string | ((props: { size: number; color: string }) => ReactNode); name?: string; color?: string; size?: number; style?: unknown; forceTextInputFocus?: boolean; onPress?: () => void }>;
    Affix: React.FC<{ text: string; textStyle?: unknown; onPress?: () => void }>;
  };
}

export {};
