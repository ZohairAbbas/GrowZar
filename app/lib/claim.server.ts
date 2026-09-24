import type { SuiteApp } from "@prisma/client";

import { prisma } from "./db.server";
import { configuredApps } from "./apps/registry.server";
import { fetchAppStatus } from "./apps/status.server";

/**
 * Attaching a proven shop to an organization, and the auto-connect that
 * follows (D-03, D-10, D-13, DECISIONS §6).
 */

export type AttachOutcome =
  | { kind: "attached"; storeId: string }
  | { kind: "already_yours"; storeId: string }
  | { kind: "needs_approval"; storeId: string; requestId: string }
  | { kind: "not_the_owner" };

/**
 * Attach a shop to an organization, or explain why not.
 *
 * A store belongs to exactly ONE organization. Every path that could produce a
 * second row for the same `shopDomain` ends somewhere else instead: a request
 * the current owner answers, or a refusal. There is no silent second row and
 * no "helpfully" moving a store.
 */
export async function attachStore(options: {
  organizationId: string;
  userId: string;
  app: SuiteApp;
  shopDomain: string;
  isStoreOwner: boolean;
}): Promise<AttachOutcome> {
  const { organizationId, userId, app, shopDomain, isStoreOwner } = options;

  const existing = await prisma.store.findUnique({
    where: { shopDomain },
    select: { id: true, organizationId: true },
  });

  if (existing) {
    if (existing.organizationId === organizationId) {
      return { kind: "already_yours", storeId: existing.id };
    }

    // Claimed by someone else. Whether this person says they own the shop or
    // not, the answer is the same shape: the organization that holds it today
    // decides. Ownership only changes what the request means.
    const request = await prisma.storeAccessRequest.upsert({
      where: {
        storeId_requestedByUserId_status: {
          storeId: existing.id,
          requestedByUserId: userId,
          status: "PENDING",
        },
      },
      update: { app, claimsOwnership: isStoreOwner, organizationId },
      create: {
        storeId: existing.id,
        organizationId,
        requestedByUserId: userId,
        app,
        claimsOwnership: isStoreOwner,
      },
      select: { id: true },
    });

    return { kind: "needs_approval", storeId: existing.id, requestId: request.id };
  }

  // Nobody holds this shop yet. Only the shop's owner may be the first to
  // claim it (§10); staff join a shop that is already claimed.
  if (!isStoreOwner) {
    return { kind: "not_the_owner" };
  }

  const store = await prisma.store.create({
    data: {
      organizationId,
      shopDomain,
      claimedByUserId: userId,
      // Currency and timezone are deliberately absent: they come from the
      // owning app on the first sync, never from a default (rules #4, #5).
    },
    select: { id: true },
  });

  return { kind: "attached", storeId: store.id };
}

export type AutoConnectResult = {
  app: SuiteApp;
  installed: boolean | null;
  reason?: string;
};

/**
 * Auto-connect (D-03).
 *
 * The store is already proven, so the merchant should not have to connect
 * anything a second time. Every configured app is asked whether it is
 * installed on this shop, and a connection row is written for the ones that
 * say yes.
 *
 * Apps are asked in parallel and no single answer can fail the claim: an app
 * that is down, unconfigured or slow simply does not produce a connection, and
 * the five-minute sync picks it up later. The merchant has already been let
 * in by this point, and blocking that on a sixth-party timeout would be the
 * wrong trade.
 */
export async function autoConnectApps(options: {
  storeId: string;
  shopDomain: string;
  /** The app the claim came through: already proven, so trusted as installed. */
  claimedThroughApp?: SuiteApp;
}): Promise<AutoConnectResult[]> {
  const { storeId, shopDomain, claimedThroughApp } = options;

  const apps = configuredApps();
  const statuses = await Promise.all(
    apps.map((credentials) =>
      fetchAppStatus(credentials.app, shopDomain, credentials),
    ),
  );

  const results: AutoConnectResult[] = [];

  for (const status of statuses) {
    if (!status.ok) {
      results.push({ app: status.app, installed: null, reason: status.reason });

      // The app the merchant pressed the button in is installed by definition
      // — they were inside it. A status endpoint that is not built yet must
      // not lose that fact.
      if (status.app === claimedThroughApp) {
        await upsertConnection(storeId, status.app, [], "claim");
        results[results.length - 1]!.installed = true;
      }
      continue;
    }

    // An app answering about a different shop is answering the wrong question;
    // taking it at face value would connect the wrong store's data.
    if (status.status.shop && status.status.shop !== shopDomain) {
      results.push({
        app: status.app,
        installed: null,
        reason: "shop_mismatch",
      });
      continue;
    }

    if (status.status.installed) {
      await upsertConnection(
        storeId,
        status.app,
        status.status.capabilities,
        "status",
      );
    }

    results.push({ app: status.app, installed: status.status.installed });
  }

  return results;
}

async function upsertConnection(
  storeId: string,
  app: SuiteApp,
  capabilities: string[],
  via: "claim" | "status",
) {
  await prisma.appConnection.upsert({
    where: { storeId_app: { storeId, app } },
    update: {
      status: "CONNECTED",
      capabilities,
      connectedAt: new Date(),
      // A reconnect clears the purge date: nothing should be deleted from a
      // store the merchant has just reconnected (D-17).
      disconnectedAt: null,
      purgeAfter: null,
      lastError: null,
    },
    create: {
      storeId,
      app,
      status: "CONNECTED",
      capabilities,
      connectedAt: new Date(),
      lastError: via === "claim" ? null : null,
    },
  });
}
