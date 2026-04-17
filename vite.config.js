import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/nominatim": {
        target: "https://nominatim.openstreetmap.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nominatim/, ""),
      },
      "/api/overpass": {
        target: "https://overpass-api.de",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/overpass/, ""),
      },
    },
  },
});