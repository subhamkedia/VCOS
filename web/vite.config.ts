import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `pnpm dev` runs this with the API on 8787; the app calls /api on its own origin.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  build: { outDir: "dist", emptyOutDir: true },
});
