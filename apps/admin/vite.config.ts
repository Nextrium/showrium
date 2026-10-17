import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The admin app: a React app (static files) and its own API Worker, on admin.showrium.com.
// Locally it uses the product's local database (apps/web), so both show the same data.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({ persistState: { path: "../web/.wrangler/state" } })],
});
