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

  // The event relay's front door (contract §7).
  route("api/v1/events", "routes/api.v1.events.ts"),

  // "Open in Growzar" lands here with a signed claim token (contract §10).
  route("claim", "routes/claim.tsx"),
  route("claim/:pendingClaimId", "routes/claim.$pendingClaimId.tsx"),

  ...prefix("stores", [
    index("routes/stores._index.tsx"),
    route(":storeId", "routes/stores.$storeId.tsx"),
  ]),

  route("switch", "routes/switch.ts"),

  // The app shell and its sections (G-GZR-6). One module serves all eight
  // non-settings sections; each needs its own route id because they share it.
  layout("routes/shell.tsx", [
    route("home", "routes/section.tsx", { id: "section-home" }),
    route("orders", "routes/section.tsx", { id: "section-orders" }),
    route("shipping", "routes/section.tsx", { id: "section-shipping" }),
    route("finance", "routes/section.tsx", { id: "section-finance" }),
    route("customers", "routes/section.tsx", { id: "section-customers" }),
    route("inventory", "routes/section.tsx", { id: "section-inventory" }),
    route("marketing", "routes/section.tsx", { id: "section-marketing" }),
    route("inbox", "routes/section.tsx", { id: "section-inbox" }),
  ]),

  layout("routes/settings.tsx", [
    ...prefix("settings", [
      index("routes/settings._index.tsx"),
      route("organization", "routes/settings.organization.tsx"),
      route("team", "routes/settings.team.tsx"),
      route("team/:memberId", "routes/settings.team.$memberId.tsx"),
      route("roles", "routes/settings.roles.tsx"),
      route("profit", "routes/settings.profit.tsx"),
    ]),
  ]),

  // Phase 1 adds: claim (the "Open in Growzar" landing) and the app shell with
  // its locked sections.
] satisfies RouteConfig;
