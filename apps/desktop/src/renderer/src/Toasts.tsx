export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const TOAST_ICONS: Record<ToastKind, string> = {
  success: "✓",
  error: "✕",
  info: "ℹ"
};

/**
 * Fixed top-right notification stack. The owner (App) pushes items and
 * removes them after a timeout; clicking a toast dismisses it early.
 */
export function ToastStack({
  toasts,
  onDismiss
}: {
  toasts: ToastItem[];
  onDismiss(id: number): void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast toast-${toast.kind}`}
          title="Dismiss"
          onClick={() => onDismiss(toast.id)}
        >
          <span className="toast-icon" aria-hidden="true">
            {TOAST_ICONS[toast.kind]}
          </span>
          <span className="toast-message">{toast.message}</span>
        </button>
      ))}
    </div>
  );
}
