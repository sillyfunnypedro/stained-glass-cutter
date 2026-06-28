import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// A build stamp shown in the UI so it's obvious which build is running.
const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return (process.env.GITHUB_SHA || "dev").slice(0, 7);
  }
})();
const buildTime = new Date().toISOString().slice(0, 16).replace("T", " ");

// base: "./" keeps asset paths relative so the built app works from any folder
// (e.g. opened locally or dropped into any static host / GitHub Pages subpath).
export default defineConfig({
  plugins: [react()],
  base: "./",
  define: {
    __BUILD_ID__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
});
