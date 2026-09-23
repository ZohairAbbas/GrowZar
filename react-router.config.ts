import type { Config } from "@react-router/dev/config";

export default {
  // Server-rendered: every screen is per-merchant data behind a session.
  ssr: true,
} satisfies Config;
