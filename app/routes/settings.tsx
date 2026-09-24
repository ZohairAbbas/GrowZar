import { Form, Link, Outlet } from "react-router";
import { LogOut } from "lucide-react";

import type { Route } from "./+types/settings";
import { requireOrganization } from "~/lib/session.server";
import { SettingsNav } from "~/components/settings/SettingsNav";

/**
 * The settings shell. The full app shell — nine sections, store switcher,
 * locked previews — is G-GZR-6; this is the frame the day-1 screens need and
 * nothing more.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { session } = await requireOrganization(request);
  return {
    user: { name: session.user.name, email: session.user.email },
  };
}

export default function SettingsLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-lg font-semibold text-primary-500">
            Growzar
          </Link>

          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-gray-600 sm:inline">
              {loaderData.user.email}
            </span>
            <Form method="post" action="/auth/sign-out">
              <button
                type="submit"
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50 hover:text-gray-900"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </Form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl gap-8 px-6 py-8 md:flex">
        <aside className="mb-6 md:mb-0 md:w-64 md:flex-shrink-0">
          <SettingsNav />
        </aside>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
