import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const rendererRoot = fileURLToPath(new URL("./src/renderer", import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@kripl/core", "@kripl/pi-adapter"] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: rendererRoot,
    plugins: [react()]
  }
});
