import IsolationActionDialog, { type IsolationActionDialogProps } from './IsolationActionDialog';
import type { IsolationEpisode } from './types';
export default function ReleaseDialog({ episode, ...props }: Omit<IsolationActionDialogProps, 'mode' | 'isolationId'> & { episode: IsolationEpisode }) {
  return <IsolationActionDialog {...props} isolationId={episode.id} mode="release" />;
}
