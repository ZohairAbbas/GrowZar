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
    // nginx proxies portal.growzar.com here, and Vite rejects a Host header it
    // does not know with "Blocked request" — a 403 that looks like an nginx
    // problem but is not. Production (react-router-serve) has no such check.
    allowedHosts: ["portal.growzar.com"],
  },
});
