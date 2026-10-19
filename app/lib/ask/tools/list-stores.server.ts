import { z } from "zod";

import { prisma } from "../../db.server";
import { APP_LABELS } from "../../sections";
import type { AskTool } from "../types";

/** Which stores the user can ask about, with their currency, timezone and connected apps. */
export const listStoresSchema = z.object({}).strict();

export const listStores: AskTool<typeof listStoresSchema> = {
  name: "list_stores",
  description: "The stores this user can ask about: id, name, currency, timezone and which apps are connected. Call it first when the question names a store or the store is unclear.",
  schema: listStoresSchema,
  sections: () => ["home"],
  run: async (_args, ctx) => {
    const connections = await prisma.appConnection.findMany({
      where: { storeId: { in: ctx.stores.map((s) => s.id) }, status: "CONNECTED" },
      select: { storeId: true, app: true },
    });
    const apps = (id: string) =>
      connections
        .filter((c) => c.storeId === id)
        .map((c) => APP_LABELS[c.app])
        .sort()
        .join(", ");
    return {
      tool: "list_stores",
      status: ctx.stores.length ? "ok" : "no_data",
      title: "Stores you can ask about",
      columns: [
        { key: "key", label: "Store id", kind: "text" },
        { key: "label", label: "Store", kind: "text" },
        { key: "currency", label: "Currency", kind: "text" },
        { key: "timezone", label: "Timezone", kind: "text" },
        { key: "apps", label: "Connected apps", kind: "text" },
      ],
      rows: ctx.stores.map((s) => ({ key: s.id, label: s.name, currency: s.currency, timezone: s.timezone, apps: apps(s.id) || "none" })),
      meta: {
        stores: ctx.stores.map(({ id, name }) => ({ id, name })),
        rules: [],
        gaps: [],
        notes: [`Organization base currency: ${ctx.baseCurrency}`, ...(ctx.stores.length ? [] : ["No stores are connected yet"])],
      },
      link: { href: "/stores", label: "Stores", exact: true },
    };
  },
};
