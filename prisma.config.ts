import "dotenv/config";
import { defineConfig, env } from "prisma/config";


/**
 * Prisma 7 moved the connection URL out of schema.prisma. Migrations and
 * introspection read it from here; the runtime client gets it through the pg
 * driver adapter in app/lib/db.server.ts.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
