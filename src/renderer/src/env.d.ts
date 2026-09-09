/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

import type { AweforkApi } from "../../shared/awefork-api";

declare global {
  interface Window {
    awefork: AweforkApi;
  }
}
