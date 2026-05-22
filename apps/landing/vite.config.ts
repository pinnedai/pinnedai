import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Alias `pinnedai` to the CLI package's library entry point so the
// landing demo runs the exact same parser + template generator as the
// CLI ships. Single source of truth.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      pinnedai: resolve(__dirname, "../cli/src/index.ts"),
    },
  },
});
