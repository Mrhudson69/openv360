import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.WORKLENS_API ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": target,
      "/install.sh": target,
      "/install.ps1": target,
      "/downloads": target,
    },
  },
});
