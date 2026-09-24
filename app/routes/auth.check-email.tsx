import { Link, useSearchParams } from "react-router";
import { Mail } from "lucide-react";

export function meta() {
  return [{ title: "Check your email · Growzar" }];
}

/**
 * Shown after a magic link is requested. It says the same thing whether or not
 * the address belongs to an account, because anything else turns this page
 * into an address checker.
 */
export default function CheckEmail() {
  const [searchParams] = useSearchParams();
  const email = searchParams.get("email");

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-xl">
        <span className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-accent-50">
          <Mail className="h-8 w-8 text-accent-500" />
        </span>
        <h1 className="text-xl font-semibold text-gray-900">Check your email</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">
          If {email ? <strong>{email}</strong> : "that address"} has a Growzar
          account, a sign-in link is on its way. It expires in 10 minutes.
        </p>
        <Link
          to="/auth/sign-in"
          className="mt-6 inline-block text-sm font-semibold text-accent-500 hover:text-accent-600"
        >
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
