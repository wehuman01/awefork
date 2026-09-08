import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// Browser-only demo of the renderer (`npm run demo`) — serves the Vue app on
// localhost without Electron or an opencode backend; the missing preload
// bridge is replaced by src/renderer/src/demo/mock-adapter.ts.
export default defineConfig({
  root: "src/renderer",
  plugins: [vue()],
  server: {
    port: 5180,
    host: "127.0.0.1",
  },
});
