import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the React app (static assets) and the Worker (API) together.
export default defineConfig({
  plugins: [react(), cloudflare()],
});
