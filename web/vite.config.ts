import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8080" } },
  build: { outDir: "dist", chunkSizeWarningLimit: 2000 },
  css: { preprocessorOptions: { scss: { api: "modern", // if-function: Carbon's own @carbon/motion still uses the legacy Sass if(); nothing under src/ does. mixed-decls is obsolete in this Sass.
      silenceDeprecations: ["global-builtin", "import", "if-function"] } } },
});
