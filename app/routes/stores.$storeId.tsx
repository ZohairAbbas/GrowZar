import { Form, Link, useNavigation } from "react-router";
import { AlertCircle, ArrowLeft, Check, UserPlus, X } from "lucide-react";

import type { Route } from "./+types/stores.$storeId";
import { Forbidden, can, requireStore } from "~/lib/authorize.server";
import { readFormData } from "~/lib/form.server";
import { prisma } from "~/lib/db.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData
        ? `${loaderData.store.shopDomain} · Growzar`
        : "Store · Growzar",
    },
  ];
}

/**
 * The acceptance case for G-GZR-2 lives here: reaching this URL for a store
 * outside the viewer's scope returns 403 from the loader, before anything is
 * queried or rendered.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { store, viewer } = await requireStore(
    request,
    params.storeId,
    "home",
    "view",
  );

  const connections = await prisma.appConnection.findMany({
    where: { storeId: store.id },
    orderBy: { app: "asc" },
    select: {
      app: true,
      status: true,
      lastSyncedAt: true,
      disconnectedAt: true,
      purgeAfter: true,
    },
  });

  // The visible per-store event log (§7): what fired, and what Growzar did
  // about it. A merchant asking "why does this still say delivered?" should be
  // able to see the answer rather than be told one.
  const events = await prisma.inboundEvent.findMany({
    where: { storeId: store.id },
    orderBy: { receivedAt: "desc" },
    take: 25,
    select: {
      id: true,
      app: true,
      topic: true,
      occurredAt: true,
      receivedAt: true,
      status: true,
      lastError: true,
    },
  });

  // Someone who proved, through an app, that they work on this shop while it
  // belongs to this organization (DECISIONS §6). Only shown to people who can
  // actually answer.
  const canDecide = await can(request, viewer.organizationId, {
    member: ["create"],
  });

  const requests = canDecide
    ? await prisma.storeAccessRequest.findMany({
        where: { storeId: store.id, status: "PENDING" },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const requesters = requests.length
    ? await prisma.user.findMany({
        where: { id: { in: requests.map((r) => r.requestedByUserId) } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const requesterById = new Map(requesters.map((user) => [user.id, user]));

  return {
    canDecide,
    accessRequests: requests.map((request) => ({
      id: request.id,
      app: request.app,
      claimsOwnership: request.claimsOwnership,
      requester: requesterById.get(request.requestedByUserId) ?? null,
      createdAt: request.createdAt.toISOString(),
    })),
    store: {
      id: store.id,
      shopDomain: store.shopDomain,
      displayName: store.displayName,
      currency: store.currency,
      timezone: store.timezone,
    },
    connections: connections.map((connection) => ({
      app: connection.app,
      status: connection.status,
      lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
      disconnectedAt: connection.disconnectedAt?.toISOString() ?? null,
      purgeAfter: connection.purgeAfter?.toISOString() ?? null,
    })),
    events: events.map((event) => ({
      id: event.id,
      app: event.app,
      topic: event.topic,
      occurredAt: event.occurredAt.toISOString(),
      receivedAt: event.receivedAt.toISOString(),
      status: event.status,
      lastError: event.lastError,
    })),
  };
}

/**
 * Approving a request adds the requester to this organization as staff scoped
 * to this store alone. It is the smallest thing that answers "let them in",
 * and an owner who wants to widen it does so on the team screen — where the
 * change is visible — rather than as a side effect of saying yes here.
 *
 * A request claiming ownership is NOT a move: moving a store between
 * organizations changes who the data belongs to, and that decision does not
 * belong behind the same button as "add a packer" (DECISIONS §6).
 */
export async function action({ request, params }: Route.ActionArgs) {
  const { store, viewer } = await requireStore(
    request,
    params.storeId,
    "home",
    "view",
  );

  if (!(await can(request, viewer.organizationId, { member: ["create"] }))) {
    throw new Forbidden("Your role does not allow answering access requests.");
  }

  const formData = await readFormData(request);
  const requestId = String(formData.get("requestId") ?? "");
  const intent = String(formData.get("intent") ?? "");

  const accessRequest = await prisma.storeAccessRequest.findFirst({
    where: { id: requestId, storeId: store.id, status: "PENDING" },
  });

  if (!accessRequest) {
    return { error: "That request has already been answered." };
  }

  if (intent === "decline") {
    await prisma.storeAccessRequest.update({
      where: { id: accessRequest.id },
      data: {
        status: "DECLINED",
        decidedByUserId: viewer.userId,
        decidedAt: new Date(),
      },
    });
    return { ok: "Request declined." };
  }

  const existingMember = await prisma.member.findFirst({
    where: {
      organizationId: viewer.organizationId,
      userId: accessRequest.requestedByUserId,
    },
    select: { id: true },
  });

  await prisma.$transaction(async (tx) => {
    const member =
      existingMember ??
      (await tx.member.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: viewer.organizationId,
          userId: accessRequest.requestedByUserId,
          role: "staff",
          createdAt: new Date(),
          scopeAllStores: false,
        },
        select: { id: true },
      }));

    // Scope them to this store only. An existing member keeps whatever scope
    // they already have; narrowing it here would quietly take away stores
    // somebody deliberately granted.
    if (!existingMember) {
      await tx.memberStoreScope.create({
        data: { memberId: member.id, storeId: store.id },
      });
    }

    await tx.storeAccessRequest.update({
      where: { id: accessRequest.id },
      data: {
        status: "APPROVED",
        decidedByUserId: viewer.userId,
        decidedAt: new Date(),
      },
    });
  });

  return { ok: "Access granted." };
}

const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "an earlier date";

const shortDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function StoreDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const { store, connections, accessRequests, canDecide, events } = loaderData;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link
        to="/stores"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 transition hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" />
        All stores
      </Link>

      <h1 className="mt-4 font-display text-2xl font-bold text-gray-900">
        {store.displayName ?? store.shopDomain}
      </h1>
      <p className="mt-1 text-sm text-gray-600">{store.shopDomain}</p>

      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Currency
          </dt>
          {/* Both come from the owning app, never a default (rules #4, #5). */}
          <dd className="mt-1 text-sm font-semibold text-gray-900">
            {store.currency ?? "Not reported yet"}
          </dd>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Timezone
          </dt>
          <dd className="mt-1 text-sm font-semibold text-gray-900">
            {store.timezone ?? "Not reported yet"}
          </dd>
        </div>
      </dl>

      {actionData?.error ? (
        <div className="mt-6 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <span>{actionData.error}</span>
        </div>
      ) : null}

      {actionData && "ok" in actionData && actionData.ok ? (
        <div className="mt-6 flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          <Check className="h-5 w-5 flex-shrink-0" />
          <span>{actionData.ok}</span>
        </div>
      ) : null}

      {canDecide && accessRequests.length > 0 ? (
        <section className="mt-8 rounded-2xl border border-amber-200 bg-amber-50/50 p-5">
          <h2 className="flex items-center gap-2 font-display text-base font-bold text-gray-900">
            <UserPlus className="h-5 w-5 text-amber-600" />
            Access requests
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            These people proved, through one of your apps, that they work on
            this shop. Nothing is shared with them until you say so.
          </p>

          <ul className="mt-4 space-y-3">
            {accessRequests.map((accessRequest) => (
              <li
                key={accessRequest.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-white p-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">
                    {accessRequest.requester?.name ?? "Someone"}
                  </p>
                  <p className="truncate text-xs text-gray-500">
                    {accessRequest.requester?.email} · via{" "}
                    {accessRequest.app.toLowerCase()}
                    {accessRequest.claimsOwnership
                      ? " · says they own this shop"
                      : ""}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Form method="post">
                    <input type="hidden" name="requestId" value={accessRequest.id} />
                    <input type="hidden" name="intent" value="decline" />
                    <button
                      type="submit"
                      disabled={navigation.state === "submitting"}
                      className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                      Decline
                    </button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="requestId" value={accessRequest.id} />
                    <input type="hidden" name="intent" value="approve" />
                    <button
                      type="submit"
                      disabled={navigation.state === "submitting"}
                      className="flex items-center gap-1 rounded-full bg-primary-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-primary-600 disabled:opacity-50"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Give access to this store
                    </button>
                  </Form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <h2 className="mt-8 font-display text-lg font-bold text-gray-900">Connected apps</h2>
      {connections.length === 0 ? (
        <p className="mt-3 text-sm text-gray-600">
          No apps connected to this store yet.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-100 rounded-2xl bg-white">
          {connections.map((connection) => (
            <li key={connection.app} className="px-5 py-3">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium capitalize text-gray-900">
                  {connection.app.toLowerCase()}
                </span>
                <span
                  className={
                    connection.status === "CONNECTED"
                      ? "text-xs font-medium uppercase tracking-wide text-green-700"
                      : "text-xs font-medium uppercase tracking-wide text-amber-700"
                  }
                >
                  {connection.status === "DISCONNECTED"
                    ? "Reconnect needed"
                    : connection.status.toLowerCase().replace(/_/g, " ")}
                </span>
              </div>

              {/*
                Reconnect mode (D-17). Nothing was deleted when the app was
                uninstalled; the data is still here, stamped with when it was
                last true, and it goes on a schedule rather than vanishing.
              */}
              {connection.status === "DISCONNECTED" ? (
                <p className="mt-1.5 text-xs leading-relaxed text-amber-800">
                  Showing data as of{" "}
                  <strong>{shortDate(connection.lastSyncedAt ?? connection.disconnectedAt)}</strong>
                  . Nothing has been deleted
                  {connection.purgeAfter
                    ? `, and nothing will be until ${shortDate(connection.purgeAfter)}`
                    : ""}
                  . Reinstall the app to pick up where you left off.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 font-display text-lg font-bold text-gray-900">Event log</h2>
      <p className="mt-1 text-sm text-gray-600">
        What your apps have told Growzar, and what Growzar did about it.
      </p>

      {events.length === 0 ? (
        <p className="mt-3 text-sm text-gray-600">
          Nothing yet. Events appear here as your apps send them.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-100 rounded-2xl bg-white">
          {events.map((event) => (
            <li
              key={event.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-sm text-gray-900">
                  {event.topic}
                </p>
                <p className="text-xs text-gray-500">
                  {event.app.toLowerCase()} · happened {shortDateTime(event.occurredAt)}
                  {/*
                    Received time is shown beside occurred time on purpose:
                    §7 gives no ordering guarantee, and the gap between the two
                    is the first thing worth seeing when something looks stale.
                  */}
                  {event.occurredAt !== event.receivedAt
                    ? ` · received ${shortDateTime(event.receivedAt)}`
                    : ""}
                </p>
                {event.lastError ? (
                  <p className="mt-0.5 text-xs text-red-600">{event.lastError}</p>
                ) : null}
              </div>
              <span
                className={`text-xs font-medium uppercase tracking-wide ${
                  event.status === "FAILED"
                    ? "text-red-600"
                    : event.status === "PROCESSED"
                      ? "text-green-700"
                      : "text-gray-500"
                }`}
              >
                {event.status.toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
