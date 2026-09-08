import { createApp } from "vue";
import App from "./app.vue";
import "./style.css";

async function bootstrap(): Promise<void> {
  // Browser demo (`npm run demo`): no Electron preload ran, so serve an
  // in-memory adapter instead. Electron dev/prod always has window.awefork
  // defined by the preload first, and prod builds cut this branch entirely.
  if (import.meta.env.DEV && !window.awefork) {
    const { installMockAdapter } = await import("./demo/mock-adapter");
    installMockAdapter();
  }
  createApp(App).mount("#app");
}

void bootstrap();
