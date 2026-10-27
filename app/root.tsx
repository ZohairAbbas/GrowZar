import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from "react-router";
import { useEffect } from "react";
import type { Route } from "./+types/root";
import { reportClientError } from "~/lib/client-error";
import { registerServiceWorker } from "~/lib/install-app";
import "./styles/globals.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Installable as an app (pre-Wave-1 pack 3): the status bar takes the page's Light Field. */}
        <meta name="theme-color" content="#F2F7F6" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/icons/growzar.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/icons/growzar-apple-180.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Growzar" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-field font-sans text-navy antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  useEffect(() => {
    registerServiceWorker();
  }, []);
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const routeError = isRouteErrorResponse(error) ? error : null;
  useEffect(() => {
    if (!routeError) reportClientError(error);
  }, [error, routeError]);

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
      <h1 className="font-display text-3xl font-bold tracking-tight">{title}</h1>
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
