import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxies API calls to the backend during `vite dev`, so the browser sees a single
// origin and the httpOnly session cookie works without CORS configuration.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/graphql": "http://localhost:4000",
      "/auth": "http://localhost:4000",
    },
  },
});
