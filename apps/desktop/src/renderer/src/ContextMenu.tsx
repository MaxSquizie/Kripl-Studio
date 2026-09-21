import { useEffect } from "react";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  run(): void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface ContextMenuProps {
  state: ContextMenuState | null;
  onClose(): void;
}

/** Small right-click action menu, styled to match the app surfaces. */
export function ContextMenu({ state, onClose }: ContextMenuProps) {
  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, onClose]);

  if (!state || state.items.length === 0) return null;

  const width = 200;
  const x = Math.max(4, Math.min(state.x, window.innerWidth - width - 8));
  const y = Math.max(4, Math.min(state.y, window.innerHeight - state.items.length * 32 - 16));

  return (
    <div
      className="context-menu-backdrop"
      onMouseDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className="context-menu"
        style={{ left: x, top: y, width }}
        role="menu"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {state.items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={"context-item" + (item.danger ? " danger" : "")}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
