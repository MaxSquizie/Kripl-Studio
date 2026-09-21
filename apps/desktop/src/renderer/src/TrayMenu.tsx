import { useEffect } from "react";

/**
 * Themed replacement for the native tray context menu. Rendered inside a
 * small frameless transparent window (see showTrayMenu in main).
 */
export function TrayMenu() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") void window.kripl.trayMenuAction("close");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = (action: "show" | "quit"): void => {
    void window.kripl.trayMenuAction(action);
  };

  return (
    <div className="tray-menu-root">
      <button type="button" className="tray-menu-item" onClick={() => run("show")}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M9 15V9l6 6V9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Show Kripl Studio
      </button>
      <div className="tray-menu-divider" />
      <button type="button" className="tray-menu-item danger" onClick={() => run("quit")}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6.5 6.5l11 11m0-11l-11 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        Quit
      </button>
    </div>
  );
}
