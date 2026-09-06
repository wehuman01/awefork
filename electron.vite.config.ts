import vue from "@vitejs/plugin-vue";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rollupOptions: {
        external: ["electron"],
        input: { index: "src/main/index.ts" },
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: {
        external: ["electron"],
        input: { index: "src/preload/index.ts" },
      },
    },
  },
  renderer: {
    build: {
      outDir: "out/renderer",
    },
    plugins: [vue()],
  },
});
