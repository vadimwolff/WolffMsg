/**
 * Shared interface primitives.
 *
 * Every one of these carries its accessibility contract with it — a Button
 * that is only an icon *requires* a label, a Field always ties its input to
 * its label and its error — so a screen cannot forget.
 */
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CloseIcon } from './icons.tsx';
import { usePresence } from '../hooks/usePresence.ts';

/* ─────────────────────────────── Button ─────────────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  fullWidth?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, fullWidth, icon, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      data-variant={variant}
      data-size={size}
      data-loading={loading ? 'true' : undefined}
      className={`btn${fullWidth ? ' btn-full' : ''}`}
      // A loading button stays focusable but is not actionable, so focus is
      // not thrown to the body mid-interaction.
      aria-busy={loading || undefined}
      disabled={props.disabled || loading}
      {...props}
    >
      {loading ? <Spinner size={size === 'lg' ? 18 : 15} /> : icon}
      {children ? <span className="btn-label">{children}</span> : null}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control has no visible text to announce. */
  label: string;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { label, variant = 'ghost', size = 'md', active, children, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        className="icon-btn"
        data-variant={variant}
        data-size={size}
        data-active={active ? 'true' : undefined}
        aria-label={label}
        title={label}
        {...props}
      >
        {children}
      </button>
    );
  },
);

/* ─────────────────────────────── Spinner ────────────────────────────────── */

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="spinner"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="44 14"
        opacity="0.9"
      />
    </svg>
  );
}

/* ──────────────────────────────── Field ─────────────────────────────────── */

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | null;
  hint?: string;
  trailing?: ReactNode;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, trailing, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  return (
    <div className="field" data-invalid={error ? 'true' : undefined}>
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="field-shell">
        <input
          ref={ref}
          id={inputId}
          className="field-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') ||
            undefined
          }
          {...props}
        />
        {trailing ? <div className="field-trailing">{trailing}</div> : null}
      </div>
      {hint && !error ? (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {/* `role="alert"` so a validation failure is announced as it appears. */}
      {error ? (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
});

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  error?: string | null;
  hint?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  function TextArea({ label, error, hint, id, ...props }, ref) {
    const generatedId = useId();
    const areaId = id ?? generatedId;
    return (
      <div className="field" data-invalid={error ? 'true' : undefined}>
        <label className="field-label" htmlFor={areaId}>
          {label}
        </label>
        <textarea ref={ref} id={areaId} className="field-input field-area" {...props} />
        {hint && !error ? <p className="field-hint">{hint}</p> : null}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);

/* ─────────────────────────────── Toggle ─────────────────────────────────── */

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="toggle-row">
      <div className="toggle-text">
        <label className="toggle-label" htmlFor={id}>
          {label}
        </label>
        {description ? <p className="toggle-description">{description}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className="toggle"
        data-checked={checked ? 'true' : undefined}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}

/* ────────────────────────────── Segmented ───────────────────────────────── */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className="segmented-option"
          data-active={value === option.value ? 'true' : undefined}
          onClick={() => onChange(option.value)}
        >
          {value === option.value ? (
            <motion.span
              layoutId={`segmented-${label}`}
              className="segmented-indicator"
              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            />
          ) : null}
          <span className="segmented-label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ──────────────────────────────── Modal ─────────────────────────────────── */

/**
 * A modal dialog.
 *
 * Handles the three things a dialog must never get wrong: Escape closes it,
 * focus moves inside on open and returns to the trigger on close, and Tab
 * cannot walk out of it into the page behind.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'full';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Presence is driven by a timer rather than by animation callbacks; see
  // `usePresence` for why an overlay must never depend on one to unmount.
  const { mounted, leaving } = usePresence(open, 180);

  useEffect(() => {
    if (!open) return;

    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(
        '[data-autofocus], input, textarea, button, [href], select, [tabindex]:not([tabindex="-1"])',
      );
      target?.focus();
    }, 40);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;

      const focusable = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(focusTimer);
      restoreFocusTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div className="modal-root" data-leaving={leaving || undefined}>
      <div className="modal-scrim" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className="modal-panel"
        data-size={size}
      >
        <header className="modal-header">
          <div>
            <h2 className="modal-title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="modal-description" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

/* ─────────────────────────────── Skeleton ───────────────────────────────── */

/**
 * Loading placeholders shaped like the content they stand in for, rather than
 * a spinner — the layout does not jump when the real thing arrives.
 */
export function Skeleton({
  width,
  height = 12,
  radius = 6,
  className,
}: {
  width?: number | string;
  height?: number;
  radius?: number;
  className?: string;
}) {
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ''}`}
      style={{
        width: typeof width === 'number' ? `${width}px` : (width ?? '100%'),
        height: `${height}px`,
        borderRadius: `${radius}px`,
      }}
      aria-hidden="true"
    />
  );
}

export function ChatListSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div className="chat-list-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="chat-row-skeleton" key={i}>
          <Skeleton width={46} height={46} radius={16} />
          <div className="chat-row-skeleton-text">
            <Skeleton width={`${45 + ((i * 13) % 35)}%`} height={11} />
            <Skeleton width={`${60 + ((i * 7) % 30)}%`} height={9} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ThreadSkeleton() {
  const widths = [42, 64, 30, 55, 38, 70, 46];
  return (
    <div className="thread-skeleton" aria-hidden="true">
      {widths.map((width, i) => (
        <div key={i} className="thread-skeleton-row" data-mine={i % 3 === 0}>
          <Skeleton width={`${width}%`} height={i % 4 === 0 ? 44 : 30} radius={16} />
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────────── Empty state ──────────────────────────────── */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <motion.div
      className="empty-state"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="empty-state-icon">{icon}</div>
      <h3 className="empty-state-title">{title}</h3>
      <p className="empty-state-description">{description}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </motion.div>
  );
}

/* ──────────────────────────────── Badge ─────────────────────────────────── */

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'positive' | 'warning' | 'danger';
}) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

/* ──────────────────────────────── Menu ──────────────────────────────────── */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}

/**
 * A popover menu with arrow-key navigation.
 *
 * Positioned by the caller through CSS; this component owns behaviour only —
 * roving focus, Escape, and closing on an outside click.
 */
export function Menu({
  open,
  onClose,
  items,
  align = 'end',
  label,
}: {
  open: boolean;
  onClose: () => void;
  items: MenuItem[];
  align?: 'start' | 'end';
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    setActive(0);

    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => (i + 1) % items.length);
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (i - 1 + items.length) % items.length);
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = items[active];
        if (item && !item.disabled) {
          item.onSelect();
          onClose();
        }
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, items, active]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={ref}
          className="menu"
          role="menu"
          aria-label={label}
          data-align={align}
          initial={{ opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -2 }}
          transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="menu-item"
              data-tone={item.tone ?? 'default'}
              data-active={index === active ? 'true' : undefined}
              disabled={item.disabled}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                item.onSelect();
                onClose();
              }}
            >
              {item.icon ? <span className="menu-item-icon">{item.icon}</span> : null}
              <span>{item.label}</span>
            </button>
          ))}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
