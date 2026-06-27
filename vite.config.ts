import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" keeps asset paths relative so the built app works from any folder
// (e.g. opened locally or dropped into any static host / GitHub Pages subpath).
export default defineConfig({
  plugins: [react()],
  base: "./",
});
