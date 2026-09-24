import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from "react-router";
import type { Route } from "./+types/root";
import "./styles/globals.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const routeError = isRouteErrorResponse(error) ? error : null;

  // A 403 is a normal outcome here, not a crash: it is what a direct URL to
  // another store's data returns for a member scoped away from it (G-GZR-2).
  // It gets a plain explanation and a way back, never a stack trace and never
  // a hint about what was on the other side.
  const forbidden = routeError?.status === 403;

  const title = forbidden
    ? "You do not have access to this"
    : routeError
      ? `${routeError.status} ${routeError.statusText}`
      : "Something went wrong";

  const detail = forbidden
    ? typeof routeError.data === "string" && routeError.data
      ? routeError.data
      : "Ask an owner or admin of your organization if you need it."
    : routeError
      ? routeError.data
      : "The error has been logged. Try again, or go back to Home.";

  return (
    <main className="mx-auto max-w-lg px-6 py-24">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-gray-600">{detail}</p>
      <a
        href="/"
        className="mt-6 inline-block text-sm font-semibold text-accent-500 hover:text-accent-600"
      >
        Go to Growzar
      </a>
    </main>
  );
}
