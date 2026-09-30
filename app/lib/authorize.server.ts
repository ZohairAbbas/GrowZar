import { auth } from "./auth.server";
import { prisma } from "./db.server";
import { redirectWithCookies, requireOrganization } from "./session.server";
import { appPathWithSearch } from "./redirects";
import { isStoreInScope, resolveScopedStoreIds, storeScopeFilter } from "./scope";
import type { Action, Section } from "./permissions";

/**
 * The permission check. Written once, used everywhere (D-12, D-20).
 *
 * Two questions are always asked together and neither is optional:
 *
 *   1. *What* — does this member's role grant `section:action`?
 *   2. *Where* — is the store they are reaching for inside their scope?
 *
 * A loader that asks only the first will happily render another store's
 * numbers to a member scoped away from it, so `requireStore` is what any route
 * with a store in its URL calls, and `requireSection` is only for pages that
 * are not about one particular store.
 *
 * None of this is enforced by hiding navigation. Hiding a link stops nobody
 * who can type a URL, which is exactly the case the acceptance test for this
 * item describes.
 */

export class Forbidden extends Response {
  constructor(reason: string) {
    super(reason, { status: 403, statusText: "Forbidden" });
  }
}

export type Viewer = {
  userId: string;
  memberId: string;
  organizationId: string;
  role: string;
  /** null means every store in the organization. */
  scopedStoreIds: string[] | null;
};

/**
 * Who is asking, and where they may look. One query, because every protected
 * loader needs it and the box has six connections to spend.
 */
export async function getViewer(request: Request): Promise<Viewer> {
  const { session, organizationId } = await requireOrganization(request);

  const member = await prisma.member.findFirst({
    where: { organizationId, userId: session.user.id },
    select: {
      id: true,
      role: true,
      scopeAllStores: true,
      storeScopes: { select: { storeId: true } },
    },
  });

  if (!member) {
    // A session pointing at an organization the user is no longer a member of.
    // Removal mid-session is the ordinary way to reach this.
    throw new Forbidden("You are not a member of this organization.");
  }

  return {
    userId: session.user.id,
    memberId: member.id,
    organizationId,
    role: member.role,
    scopedStoreIds: resolveScopedStoreIds(
      member.scopeAllStores,
      member.storeScopes,
    ),
  };
}

/**
 * Does the viewer's role grant this permission?
 *
 * Better Auth answers rather than a local lookup in `roles`, because an
 * organization's custom roles (dynamicAccessControl) live in the database and
 * a local table would not know about them.
 */
export async function can(
  request: Request,
  organizationId: string,
  permissions: Record<string, string[]>,
): Promise<boolean> {
  const result = await auth.api.hasPermission({
    body: { organizationId, permissions },
    headers: request.headers,
  });
  return Boolean(result?.success);
}

export function hasPermission(
  request: Request,
  organizationId: string,
  section: Section,
  action: Action,
): Promise<boolean> {
  return can(request, organizationId, { [section]: [action] });
}

/**
 * For pages that are not about one store: settings, the organization-wide
 * home, the section index that then lists the stores the viewer may see.
 */
export async function requireSection(
  request: Request,
  section: Section,
  action: Action = "view",
): Promise<Viewer> {
  const viewer = await getViewer(request);

  if (!(await hasPermission(request, viewer.organizationId, section, action))) {
    throw new Forbidden(
      `Your role does not allow ${action} on ${section}.`,
    );
  }

  return viewer;
}

/**
 * For anything with a store in the URL. Returns the store, so the caller does
 * not fetch it a second time.
 *
 * A store in another organization and a store outside the viewer's scope both
 * return 403 and say the same thing. Distinguishing them would turn this
 * endpoint into a way to find out which shop domains exist.
 */
export async function requireStore(
  request: Request,
  storeId: string,
  section: Section,
  action: Action = "view",
) {
  const viewer = await requireSection(request, section, action);

  const store = await prisma.store.findFirst({
    where: { id: storeId, organizationId: viewer.organizationId },
  });

  if (!store) {
    // The store may genuinely be theirs, through a different organization —
    // which is exactly what happens when an owner approves a join request
    // (DECISIONS §6): the requester becomes a member of the owning
    // organization while their session still points at their own. Switching
    // the active organization is the honest answer; 403 would be telling
    // someone they cannot see a store they have just been given.
    //
    // Only a real membership triggers it, so this reveals nothing to anyone
    // who was not already let in.
    const elsewhere = await prisma.store.findFirst({
      where: {
        id: storeId,
        organization: { members: { some: { userId: viewer.userId } } },
      },
      select: { organizationId: true },
    });

    if (elsewhere) {
      const activated = await auth.api.setActiveOrganization({
        body: { organizationId: elsewhere.organizationId },
        headers: request.headers,
        asResponse: true,
      });
      throw redirectWithCookies(activated, appPathWithSearch(request));
    }

    throw new Forbidden("That store is not available to you.");
  }

  if (!isStoreInScope(viewer.scopedStoreIds, store.id)) {
    throw new Forbidden("That store is not available to you.");
  }

  return { viewer, store };
}

/**
 * Every store the viewer may see, already narrowed. Any list of stores is
 * built from this and never from a bare `findMany` on the organization.
 */
export async function listVisibleStores(viewer: Viewer) {
  return prisma.store.findMany({
    where: {
      organizationId: viewer.organizationId,
      ...storeScopeFilter(viewer.scopedStoreIds),
    },
    orderBy: { shopDomain: "asc" },
  });
}

/**
 * The sections this viewer may open, for the shell's navigation (G-GZR-6) and
 * for hiding what would 403 anyway. This is presentation; it is never the
 * enforcement.
 */
export async function visibleSections(
  request: Request,
  organizationId: string,
  sections: readonly Section[],
): Promise<Set<Section>> {
  const results = await Promise.all(
    sections.map(async (section) => ({
      section,
      allowed: await hasPermission(request, organizationId, section, "view"),
    })),
  );

  return new Set(
    results.filter((entry) => entry.allowed).map((entry) => entry.section),
  );
}
