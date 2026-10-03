import { Link, redirect } from "react-router";
import { ArrowRight } from "lucide-react";

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
    <main className="flex min-h-screen items-center justify-center bg-field px-4 py-12">
      <div className="w-full max-w-xl rounded-2xl bg-navy p-10 text-white">
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 font-display text-xl font-bold leading-none text-mint">
            g
          </span>
          <span className="font-display text-2xl font-bold">growzar</span>
        </div>
        <h1 className="mt-8 font-display text-4xl font-bold leading-tight tracking-tight">
          One place for the apps you already run.
        </h1>
        <p className="mt-3 text-navy-muted">
          Open Growzar from inside any of your apps to connect a store.
        </p>
        <Link
          to="/auth/sign-in"
          className="mt-8 inline-flex items-center gap-2 rounded-full bg-mint px-5 py-3 font-bold text-navy hover:bg-mint-200"
        >
          Sign in <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </main>
  );
}
