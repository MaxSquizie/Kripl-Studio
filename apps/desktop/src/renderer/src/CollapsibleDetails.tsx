import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * A <details> element whose body animation replays on every open.
 * Chromium does not restart CSS animations when a closed <details> is
 * reopened (the content stays in the DOM), so the body is remounted via
 * a changing key each time the panel opens.
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
  /** Start expanded. Native toggling afterwards is not re-synced by React. */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [openTick, setOpenTick] = useState(0);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    const element = detailsRef.current;
    if (!element) return;
    const onToggle = (): void => {
      if (element.open) setOpenTick((tick) => tick + 1);
    };
    element.addEventListener("toggle", onToggle);
    return () => element.removeEventListener("toggle", onToggle);
  }, []);

  return (
    <details ref={detailsRef} className={className} open={defaultOpen || undefined}>
      <summary>{summary}</summary>
      {bodyClassName ? (
        <div key={openTick} className={bodyClassName}>
          {children}
        </div>
      ) : (
        <div key={openTick}>{children}</div>
      )}
    </details>
  );
}
