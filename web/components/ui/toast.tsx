import * as React from 'react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

const ToastProvider = ToastPrimitive.Provider;
function ToastViewport({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return <ToastPrimitive.Viewport className={cn('toast-viewport', className)} {...props} />;
}
function Toast({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Root>) {
  return <ToastPrimitive.Root className={cn('toast-root', className)} {...props} />;
}
function ToastTitle({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Title>) {
  return <ToastPrimitive.Title className={cn('toast-title', className)} {...props} />;
}
function ToastAction({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Action>) {
  return <ToastPrimitive.Action className={cn('toast-action', className)} {...props} />;
}
function ToastClose(props: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close className="toast-close" aria-label="Dismiss notification" {...props}>
      <X size={16} aria-hidden="true" />
    </ToastPrimitive.Close>
  );
}
export { ToastProvider, ToastViewport, Toast, ToastTitle, ToastAction, ToastClose };
