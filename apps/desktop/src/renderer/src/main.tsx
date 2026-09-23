import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { TrayMenu } from "./TrayMenu";
import "./styles.css";
import "./model-provider.css";
import "./agent.css";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element was not found.");

if (!window.kripl) {
  root.innerHTML = `
    <main style="
      height:100%;
      display:grid;
      place-items:center;
      padding:32px;
      background:#0d1014;
      color:#eef7f1;
      font-family:Inter,ui-sans-serif,system-ui,sans-serif;
    ">
      <section style="
        width:min(620px,100%);
        border:1px solid #29483a;
        border-radius:14px;
        background:#111a16;
        padding:24px;
      ">
        <div style="color:#7ed8a4;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">
          Kripl Studio startup error
        </div>
        <h1 style="margin:10px 0 8px;font-size:24px;">Desktop bridge did not load.</h1>
        <p style="margin:0;color:#aebdb4;line-height:1.55;">
          The Electron preload module is unavailable. This build cannot access the workspace or agent runtime.
        </p>
      </section>
    </main>
  `;
} else {
  // Capture errors that escape React (event handlers, IPC callbacks) so a
  // blank window in an installed build leaves a trace behind.
  window.addEventListener("error", (event) => {
    void window.kripl?.logRendererError(
      `Uncaught error: ${event.message} @${event.filename}:${event.lineno}\n${event.error?.stack ?? ""}`
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error ? event.reason.stack ?? event.reason.message : String(event.reason);
    void window.kripl?.logRendererError(`Unhandled rejection: ${reason}`);
  });

  // The tray action menu runs in its own tiny frameless window.
  const isTrayMenu = window.location.search.includes("tray-menu=1");
  if (isTrayMenu) {
    // The window is transparent; the :root background would otherwise show
    // as square corners around the rounded menu card.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }

  createRoot(root).render(
    <ErrorBoundary>
      <StrictMode>{isTrayMenu ? <TrayMenu /> : <App />}</StrictMode>
    </ErrorBoundary>
  );
}
