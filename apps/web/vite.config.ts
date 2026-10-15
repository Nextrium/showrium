import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the React app (static assets, styled with Tailwind v4) and the Worker (API) together.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
});
