import { useEffect, useState } from 'react';
import * as Toast from '@radix-ui/react-toast';

interface ToastMessage {
  id: number;
  text: string;
}

const AUTO_DISMISS_MS = 2500;

let nextId = 0;
type Listener = (msg: ToastMessage) => void;
const listeners = new Set<Listener>();

/** Global, imperative toast trigger — call from anywhere, no hook required. */
export function toast(message: string): void {
  const msg: ToastMessage = { id: nextId++, text: message };
  listeners.forEach((listener) => listener(msg));
}

/**
 * Mount once near the root of a view that calls `toast()`. Renders Radix
 * Toast.Provider + a bottom-center viewport; each toast auto-dismisses
 * after `AUTO_DISMISS_MS`.
 */
export function Toaster() {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const listener: Listener = (msg) => setMessages((cur) => [...cur, msg]);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const dismiss = (id: number) => {
    setMessages((cur) => cur.filter((m) => m.id !== id));
  };

  return (
    <Toast.Provider duration={AUTO_DISMISS_MS} swipeDirection="down">
      {messages.map((m) => (
        <Toast.Root
          key={m.id}
          className="ws-toast"
          onOpenChange={(open) => {
            if (!open) dismiss(m.id);
          }}
        >
          <Toast.Description className="ws-toast-desc">{m.text}</Toast.Description>
        </Toast.Root>
      ))}
      <Toast.Viewport className="ws-toast-viewport" />
    </Toast.Provider>
  );
}
