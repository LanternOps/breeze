import type { AiConnectionDto } from '@breeze/shared';
import { OpenAiCompatibleConnectionForm, type OpenAiDraft } from './OpenAiCompatibleConnectionForm';
import type { AddableConnectionKind } from './connectionKinds';

export type KindDraft = { kind: 'openai_compatible'; draft: OpenAiDraft };

/**
 * One form per non-Anthropic connection kind inside ConnectionDrawer (W06 shared extension point).
 * W07 adds bedrock / vertex / foundry cases; the `never` default makes that a compile error until it does.
 */
export function ConnectionKindForm(props: {
  kind: AddableConnectionKind;
  connection: AiConnectionDto | null;
  onDraftChange: (d: KindDraft) => void;
}) {
  const { onDraftChange } = props;
  switch (props.kind) {
    case 'anthropic_byok':
      return null; // W04's key/endpoint fields render this kind in ConnectionDrawer itself
    case 'openai_compatible':
      return (
        <OpenAiCompatibleConnectionForm
          connection={props.connection}
          onChange={(draft) => onDraftChange({ kind: 'openai_compatible', draft })}
        />
      );
    default: {
      const unreachable: never = props.kind;
      return <p>{String(unreachable)}</p>;
    }
  }
}
