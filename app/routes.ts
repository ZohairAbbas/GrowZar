import {
  type RouteConfig,
  index,
  layout,
  prefix,
  route,
} from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),

  // Liveness and readiness, used by monitoring (OPS-GROWZAR-SETUP.md step 6).
  route("health", "routes/health.ts"),

  // Better Auth's own endpoints: the magic-link callback, sign-out, and the
  // organization plugin's routes.
  route("api/auth/*", "routes/api.auth.$.ts"),

  ...prefix("auth", [
    route("sign-in", "routes/auth.sign-in.tsx"),
    route("sign-up", "routes/auth.sign-up.tsx"),
    route("sign-out", "routes/auth.sign-out.ts"),
    route("check-email", "routes/auth.check-email.tsx"),
  ]),

  // An invitation link lands here. It has to work for someone with no account
  // yet, so it is deliberately outside the signed-in shell.
  route("invitations/:invitationId", "routes/invitations.$invitationId.tsx"),

  route("organizations/new", "routes/organizations.new.tsx"),

  layout("routes/settings.tsx", [
    ...prefix("settings", [
      index("routes/settings._index.tsx"),
      route("organization", "routes/settings.organization.tsx"),
      route("team", "routes/settings.team.tsx"),
    ]),
  ]),

  // Phase 1 adds: claim (the "Open in Growzar" landing) and the app shell with
  // its locked sections.
] satisfies RouteConfig;
