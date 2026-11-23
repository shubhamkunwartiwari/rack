import { useEffect, type ReactNode } from 'react'

export type ToastAction = { label: string; onClick: () => void }
export type Toast = { id: string; message: string; action?: ToastAction }
export type Notify = (message: string, action?: ToastAction) => void

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

export type IconName =
  | 'plus'
  | 'close'
  | 'chevron'
  | 'projects'
  | 'settings'
  | 'help'
  | 'search'
  | 'export'
  | 'undo'
  | 'redo'
  | 'fit'
  | 'layout'
  | 'trash'
  | 'check'
  | 'warn'
  | 'fail'
  | 'dot'
  | 'restore'

const PATHS: Record<IconName, ReactNode> = {
  plus: <path d="M8 3v10M3 8h10" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  chevron: <path d="M4 6.5L8 10l4-3.5" />,
  projects: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.2 6.2a1.9 1.9 0 113 1.6c-.7.4-1.2.8-1.2 1.6" />
      <path d="M8 11.9v.1" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2L13.5 13.5" />
    </>
  ),
  export: <path d="M8 2v8M4.8 6.6L8 9.8l3.2-3.2M2.8 12.4v1h10.4v-1" />,
  undo: <path d="M5.5 5H10a3.5 3.5 0 010 7H6M5.5 5L8 2.5M5.5 5L8 7.5" />,
  redo: <path d="M10.5 5H6a3.5 3.5 0 000 7h4M10.5 5L8 2.5M10.5 5L8 7.5" />,
  fit: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  layout: (
    <>
      <rect x="2" y="6" width="4" height="4" rx="1" />
      <rect x="10" y="2.5" width="4" height="3.5" rx="1" />
      <rect x="10" y="9.5" width="4" height="3.5" rx="1" />
      <path d="M6 8h4M9 4.5H8v7h1" />
    </>
  ),
  trash: <path d="M3 5h10M6 5V3h4v2M4.5 5l.6 8h5.8l.6-8M6.8 7.5v3M9.2 7.5v3" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  warn: (
    <>
      <path d="M8 2.5L14 13H2L8 2.5z" />
      <path d="M8 6.2v3.2M8 11.2v.1" />
    </>
  ),
  fail: <path d="M4 4l8 8M12 4l-8 8" />,
  dot: <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />,
  restore: <path d="M3 8a5 5 0 105-5H4M3 3v2.5h2.5" />,
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
  return (
    <div className="overlay" role="presentation" onPointerDown={onClose}>
      <div
        className={`modal${wide ? ' modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">
        ⌗
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string
  hint?: string
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

export function NumberInput({
  value,
  onChange,
  min = 0,
  max = 1e9,
  step = 1,
  ariaLabel,
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  ariaLabel?: string
}) {
  return (
    <input
      className="num"
      type="number"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(event) => {
        const next = Number(event.target.value)
        onChange(Number.isFinite(next) ? Math.min(Math.max(next, min), max) : min)
      }}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          className={option.value === value ? 'on' : ''}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Sparkbars({ progress }: { progress: number[] }) {
  return (
    <span className="sparkbars" aria-hidden="true">
      {progress.length === 0
        ? [0, 0, 0, 0, 0].map((_, index) => <i key={index} style={{ height: 3 }} />)
        : progress.map((value, index) => (
            <i
              key={index}
              style={{ height: 4 + Math.round(Math.min(1, Math.max(0, value)) * 14) }}
            />
          ))}
    </span>
  )
}

export function Toasts({
  toasts,
  dismiss,
}: {
  toasts: Toast[]
  dismiss: (id: string) => void
}) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div className="toast" key={toast.id}>
          <span>{toast.message}</span>
          {toast.action && (
            <button
              className="quiet"
              onClick={() => {
                toast.action?.onClick()
                dismiss(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            className="icon-btn small"
            aria-label="Dismiss"
            onClick={() => dismiss(toast.id)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <span key={index} style={{ width: `${92 - index * 12}%` }} />
      ))}
    </div>
  )
}
