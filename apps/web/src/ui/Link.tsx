import type { ReactNode } from "react";
import { navigate } from "../lib";

/** In-app link: navigates without a page load (and asks first if a form has unsaved changes). */
export function Link({ to, children, className, ariaCurrent, ariaLabel, title, onNavigate }: {
  to: string;
  children: ReactNode;
  className?: string | undefined;
  ariaCurrent?: boolean | undefined;
  ariaLabel?: string | undefined;
  title?: string | undefined;
  onNavigate?: (() => void) | undefined;
}) {
  if (/^https?:/.test(to)) {
    return (
      <a href={to} className={className} aria-label={ariaLabel} title={title}>
        {children}
      </a>
    );
  }
  return (
    <a
      href={to}
      className={className}
      aria-current={ariaCurrent ? "page" : undefined}
      aria-label={ariaLabel}
      title={title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
        onNavigate?.();
      }}
    >
      {children}
    </a>
  );
}
