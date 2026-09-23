import { reactRouter } from "@react-router/dev/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  server: {
    // Dev runs on this VPS beside four production apps. 3020-3022 are free;
    // 3020 is Growzar's (see docs/deploy/growzar.service).
    port: 3020,
    host: "127.0.0.1",
  },
});
