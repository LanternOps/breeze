import { useId } from 'react';
import { Paperclip } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WispState } from '@/stores/aiStore';
import { WispPopover } from '../wisp/WispPopover';
import WispThreadAttachments from './WispThreadAttachments';
import { useWispThreadAttachmentList, wispAttachmentsNeedFocus } from './useWispThreadAttachmentList';

/**
 * The docked pane's attachments (#critique): a paperclip in the composer with
 * a count, opening the thread's attachments above it. A partner-wide thread
 * with no customer focus cannot attach, but it still opens: the attachments
 * already on the thread stay readable, and the reason sits inline above the
 * disabled inputs as the dialog's description.
 */
export default function WispAttachmentsButton({ wisp }: { wisp: NonNullable<WispState> }) {
  const { t } = useTranslation('ai');
  const list = useWispThreadAttachmentList(wisp.threadId);
  const count = list.items.length;
  const title = t('wisp.attachments.title');
  const reasonId = useId();

  return (
    <WispPopover
      label={title}
      triggerLabel={count > 0 ? `${title} (${count})` : title}
      describedBy={wispAttachmentsNeedFocus(wisp) ? reasonId : null}
      testId="wisp-attachments-toggle"
      panelTestId="wisp-attachments-popover"
      triggerClassName="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      panelClassName="bottom-full left-0 mb-2 max-h-[60vh] w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-3"
      trigger={(
        <>
          <Paperclip className="h-4 w-4" aria-hidden="true" />
          {count > 0 && (
            <span
              data-testid="wisp-attachments-count"
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-xs font-medium leading-none text-primary-foreground"
            >
              {count}
            </span>
          )}
        </>
      )}
    >
      <WispThreadAttachments wisp={wisp} list={list} showTitle={false} reasonId={reasonId} />
    </WispPopover>
  );
}
