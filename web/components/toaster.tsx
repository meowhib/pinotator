import { useSyncExternalStore } from 'react';
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from './ui/toast.js';

type Notification = { id: number; message: string; review: boolean };
let notifications: Notification[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => notifications;
function dismiss(id: number) {
  notifications = notifications.filter((item) => item.id !== id);
  listeners.forEach((listener) => listener());
}
export function showToast(message: string, review = false) {
  notifications = [...notifications.slice(-2), { id: ++nextId, message, review }];
  listeners.forEach((listener) => listener());
}
export function Toaster() {
  const items = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <ToastProvider duration={8000} swipeDirection="right">
      {items.map((item) => (
        <Toast
          key={item.id}
          open
          onOpenChange={(open) => {
            if (!open) dismiss(item.id);
          }}
        >
          <ToastTitle>{item.message}</ToastTitle>
          {item.review && (
            <ToastAction asChild altText="Review staged changes before applying">
              <a href="/changes" onClick={() => dismiss(item.id)}>
                Review changes
              </a>
            </ToastAction>
          )}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport label="Notifications ({hotkey})" />
    </ToastProvider>
  );
}
