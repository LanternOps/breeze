import type { ComponentType } from 'react';

import { PromptCard, type PromptCardProps } from '../PromptCard';
import { NoticeCard } from './notice';

/*
 * The card component for each prompt kind (#10190). Each wave adds its kind
 * in its own `kinds/<kind>.tsx` and one line here; anything else (a kind this
 * build does not advertise never reaches a card) gets the generic card.
 */
const CARDS: Record<string, ComponentType<PromptCardProps>> = {
  'notice.info': NoticeCard,
};

export function cardForKind(kind: string): ComponentType<PromptCardProps> {
  return Object.prototype.hasOwnProperty.call(CARDS, kind) ? CARDS[kind]! : PromptCard;
}
