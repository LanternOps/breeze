import { useEffect, type RefObject } from 'react';

/**
 * Calls `onOutside` when a mousedown lands outside the referenced element.
 * Mirrors useEscapeClose: the listener is only attached while `isActive`.
 * Standardizes the click-outside pattern that FieldSelector, FilterAddDropdown,
 * and the chip popover each hand-rolled.
 */
export function useClickOutside<T extends HTMLElement>(
  isActive: boolean,
  ref: RefObject<T | null>,
  onOutside: () => void,
) {
  useEffect(() => {
    if (!isActive) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onOutside();
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isActive, ref, onOutside]);
}
