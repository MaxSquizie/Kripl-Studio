import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const rendererRoot = fileURLToPath(new URL("./src/renderer", import.meta.url));
const internalPackages = ["@kripl/core", "@kripl/local-openai-provider", "@kripl/workspace", "@kripl/pi-adapter"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: internalPackages })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: rendererRoot,
    plugins: [react()]
  }
});
