import { useEffect, useRef } from 'react';

/**
 * Register keyboard shortcuts for a page.
 * @param {Array<{ key: string, ctrl?: boolean, shift?: boolean, handler: Function, allowInInput?: boolean }>} shortcuts
 */
export function useKeyboardShortcuts(shortcuts) {
  const ref = useRef(shortcuts);
  useEffect(() => { ref.current = shortcuts; });

  useEffect(() => {
    const handler = (e) => {
      const isTyping =
        e.target.tagName === 'INPUT' ||
        e.target.tagName === 'TEXTAREA' ||
        e.target.tagName === 'SELECT' ||
        e.target.isContentEditable;

      for (const shortcut of ref.current) {
        const ctrlMatch = shortcut.ctrl ? (e.metaKey || e.ctrlKey) : !(e.metaKey || e.ctrlKey);
        const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey;
        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();

        if (keyMatch && ctrlMatch && shiftMatch) {
          if (isTyping && !shortcut.allowInInput && !shortcut.ctrl) continue;
          e.preventDefault();
          shortcut.handler(e);
          return;
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}
