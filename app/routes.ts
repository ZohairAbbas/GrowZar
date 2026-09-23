import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),

  // Liveness and readiness, used by monitoring (OPS-GROWZAR-SETUP.md step 6).
  route("health", "routes/health.ts"),

  // Phase 1 adds: auth.*, claim (the "Open in Growzar" landing), settings.*,
  // and the app shell with its locked sections.
] satisfies RouteConfig;
