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
      <div className="tray-menu-card">
        <button type="button" className="tray-menu-item" onClick={() => run("show")}>
          Show Kripl Studio
        </button>
        <button type="button" className="tray-menu-item danger" onClick={() => run("quit")}>
          Quit
        </button>
      </div>
    </div>
  );
}
