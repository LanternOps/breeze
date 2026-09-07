import { useEffect, useState } from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

import { keyboardHideEventName, keyboardShowEventName } from './keyboardHeightEvents';

/**
 * Tracks the on-screen height of the OS keyboard, 0 when hidden.
 *
 * #5171: a Toast rendered as a sibling of a screen's scrollable content is
 * NOT lifted along with a composer that `KeyboardAvoidingView`/scroll-inset
 * logic pushes above the keyboard, so a toast cleared only for the
 * composer's own height still paints mid-composer while the keyboard is
 * open. Screens that can show a toast while a keyboard may be open should
 * fold this into `toastClearanceOffset` (`components/timerBarLogic.ts`).
 *
 * No render-testable logic lives here — this project's vitest runtime has no
 * React Native test renderer (see `MfaChallengeScreen.test.ts`) — so the only
 * per-platform decision (which event pair to subscribe to) is factored out
 * into the pure, tested `keyboardHeightEvents.ts`.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const platformOS = Platform.OS;
    const onShow = (e: KeyboardEvent) => setHeight(e.endCoordinates?.height ?? 0);
    const onHide = () => setHeight(0);

    const showSub = Keyboard.addListener(keyboardShowEventName(platformOS), onShow);
    const hideSub = Keyboard.addListener(keyboardHideEventName(platformOS), onHide);

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return height;
}
