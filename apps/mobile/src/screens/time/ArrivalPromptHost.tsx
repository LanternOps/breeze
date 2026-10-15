import { ArrivalSheet } from './ArrivalSheet';
import { useArrivalPrompt } from './useArrivalPrompt';

/** Mounted once in MainNavigator, beside the tab bar's TimerBar. Renders nothing until a prompt is due. */
export function ArrivalPromptHost(): React.JSX.Element | null {
  const prompt = useArrivalPrompt();
  if (prompt.state === null) return null;
  return (
    <ArrivalSheet
      state={prompt.state}
      busy={prompt.busy}
      onPickSite={prompt.onPickSite}
      onStart={prompt.onStart}
      onDismiss={prompt.onDismiss}
      onStop={prompt.onStop}
      onKeepRunning={prompt.onKeepRunning}
    />
  );
}
