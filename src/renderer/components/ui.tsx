import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import type { Toast } from '../lib/hooks';
import { highlight, type Range } from '../lib/search';

type Tone = 'primary' | 'secondary' | 'danger' | 'ghost';
const TONES: Readonly<Record<Tone, string>> = {
  primary: 'bg-amber-600 text-white hover:bg-amber-700 disabled:bg-amber-600/50',
  secondary:
    'bg-zinc-200 text-zinc-900 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  ghost: 'text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-700',
};

export function Button({
  tone = 'secondary',
  className = '',
  type = 'button',
  ...props
}: ComponentProps<'button'> & { tone?: Tone }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none disabled:cursor-not-allowed ${TONES[tone]} ${className}`}
      {...props}
    />
  );
}

export const inputClass =
  'w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100';

export function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: ReactNode;
  help?: string;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex flex-col gap-1">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
        {children}
      </label>
      {help === undefined ? null : <span className="text-xs text-zinc-500">{help}</span>}
    </div>
  );
}

export function Highlighted({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  return (
    <>
      {highlight(text, ranges).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-sm bg-amber-200 text-inherit dark:bg-amber-700/60">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function Toasts({ toasts }: { toasts: readonly Toast[] }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-3 bottom-3 z-50 flex flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          className={`max-w-sm rounded-md px-3 py-2 text-sm shadow-lg ${
            toast.tone === 'error'
              ? 'bg-red-600 text-white'
              : toast.tone === 'success'
                ? 'bg-emerald-600 text-white'
                : 'bg-zinc-800 text-white'
          }`}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}

/** Modal confirmation; Enter confirms, Escape cancels. */
export function Confirm({
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape closes the dialog; its buttons are focusable */}
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={message}
        className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl dark:bg-zinc-800"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <p className="mb-4 text-sm text-zinc-800 dark:text-zinc-100">{message}</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button ref={confirmRef} tone={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Move the focus into the dialog (unless a control already took it with autoFocus)
  // and give it back to whatever had it when the dialog closes.
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) dialog.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape closes the dialog; its controls are focusable */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-full w-full max-w-lg overflow-auto rounded-lg bg-white p-4 shadow-xl focus:outline-none dark:bg-zinc-800"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className="mb-3 text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        {children}
      </div>
    </div>
  );
}
