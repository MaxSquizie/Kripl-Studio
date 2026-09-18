import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./model-provider.css";
import "./agent.css";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element was not found.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
