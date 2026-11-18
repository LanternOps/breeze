import IsolationActionDialog, { type IsolationActionDialogProps } from './IsolationActionDialog';
export default function IsolateDialog(props: Omit<IsolationActionDialogProps, 'mode' | 'isolationId'>) {
  return <IsolationActionDialog {...props} mode="start" />;
}
