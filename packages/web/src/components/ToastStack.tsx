import { AnimatePresence, motion } from 'framer-motion';
import { useUi } from '../store/ui.ts';
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from './icons.tsx';
import { IconButton } from './primitives.tsx';

const ICONS = {
  info: InfoIcon,
  success: CheckIcon,
  warning: AlertIcon,
  danger: AlertIcon,
} as const;

/**
 * Transient notices.
 *
 * `aria-live="polite"` rather than `assertive`: a toast never interrupts what
 * someone is doing, and an error that genuinely blocks progress belongs
 * inline, not here.
 */
export function ToastStack() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const Icon = ICONS[toast.tone];
          return (
            <motion.div
              key={toast.id}
              className="toast"
              data-tone={toast.tone}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 400, damping: 32 }}
            >
              <span className="toast-icon">
                <Icon size={16} />
              </span>
              <span className="toast-message">{toast.message}</span>
              {toast.action ? (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    toast.action?.run();
                    dismiss(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              ) : null}
              <IconButton
                label="Dismiss"
                size="sm"
                onClick={() => dismiss(toast.id)}
              >
                <CloseIcon size={14} />
              </IconButton>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
