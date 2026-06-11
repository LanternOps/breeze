import { Easing } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

// Single ease curve everywhere. ease-out-quint is calm and confident at
// medium durations (200–400ms). No bounce, no elastic.
export const ease = Easing.bezier(0.22, 1, 0.36, 1);

// Durations in ms. Keep this small set — variance is in the curve, not in
// the speed.
export const duration = {
  fast: 180,    // tab fade, small state changes
  base: 240,    // most transitions
  swell: 320,   // success wash, card lift
  enter: 400,   // approval entrance
  exit: 280,    // approval dismiss
} as const;

export const haptic = {
  // Approval entrance: a soft buzz, not a startle.
  arrive: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft),
  // Approve confirmed.
  approve: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  // Deny: sharper but not warning-tier.
  deny: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  // Biometric prompt cancel / generic feedback.
  tap: () => Haptics.selectionAsync(),
  // Recursive hold completes.
  hold: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  // Expiry — no haptic, intentional silence.
};
