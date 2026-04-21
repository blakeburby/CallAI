import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: true,
    outDir: "public"
  },
  server: {
    proxy: {
      "/frontend": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/operator": "http://localhost:3000",
      "/runner": "http://localhost:3000",
      "/sms": "http://localhost:3000",
      "/tools": "http://localhost:3000",
      "/voice": "http://localhost:3000",
      "/vapi": "http://localhost:3000"
    }
  }
});
