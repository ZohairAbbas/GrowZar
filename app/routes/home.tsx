import { redirect } from "react-router";

import type { Route } from "./+types/home";
import { getSession } from "~/lib/session.server";

export function meta() {
  return [{ title: "Growzar" }];
}

/**
 * The front door. Someone already signed in wants the shell, not the pitch.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (session) throw redirect("/home");
  return null;
}

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-3xl font-semibold text-primary-500">Growzar</h1>
      <p className="mt-3 text-gray-600">
        One place for the apps you already run. Open Growzar from inside any of
        your apps to connect a store.
      </p>
    </main>
  );
}
