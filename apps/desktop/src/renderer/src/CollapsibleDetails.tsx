import { useState } from "react";
import type { ReactNode } from "react";

/**
 * Only mount the body while expanded. Besides replaying its entrance
 * animation, this keeps closed reasoning / tool output out of React's render
 * work and the DOM. A render callback also defers expensive body preparation.
 */
export function CollapsibleDetails({
  className,
  summary,
  bodyClassName,
  defaultOpen = false,
  children
}: {
  className: string;
  summary: ReactNode;
  bodyClassName?: string | undefined;
  /** Initial state only; subsequent toggles belong to the user. */
  defaultOpen?: boolean;
  children: ReactNode | (() => ReactNode);
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      className={className}
      open={open || undefined}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      {open && <div className={bodyClassName}>{typeof children === "function" ? children() : children}</div>}
    </details>
  );
}
