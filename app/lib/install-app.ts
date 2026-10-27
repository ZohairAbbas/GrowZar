import { useSyncExternalStore } from "react";

/**
 * "Install the Growzar app" (pre-Wave-1 pack 3).
 *
 * Chrome and Edge offer an install through `beforeinstallprompt`, which has to
 * be caught and kept until the merchant asks: it fires once, possibly before
 * React has hydrated, so the listener goes on at module load. iPhone and iPad
 * never fire it; there, installing is Share → Add to Home Screen, so the offer
 * is a how-to. Running as the installed app, there is nothing to offer.
 */
export type InstallOffer = "prompt" | "ios" | null;

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/** The rule, apart from the browser so it can be tested. */
export function installOffer(device: {
  standalone: boolean;
  hasPrompt: boolean;
  userAgent: string;
  maxTouchPoints: number;
}): InstallOffer {
  if (device.standalone) return null;
  if (device.hasPrompt) return "prompt";
  return isIos(device.userAgent, device.maxTouchPoints) ? "ios" : null;
}

/** iPhone, iPod, or an iPad, which since iPadOS 13 calls itself a Mac with a touch screen. */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

let deferred: PromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as PromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    notify();
  });
}

function current(): InstallOffer {
  const standalone =
    installed ||
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return installOffer({ standalone, hasPrompt: deferred !== null, userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInstallOffer(): InstallOffer {
  return useSyncExternalStore(subscribe, current, () => null);
}

/** Shows the browser's own install dialog; the offer goes once it is used either way. */
export async function promptInstall() {
  const event = deferred;
  if (!event) return;
  deferred = null;
  notify();
  await event.prompt();
  await event.userChoice.catch(() => null);
}

/** Registers the service worker after load, in a production build only (dev serves no stamped worker). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Without it Growzar still works; it just can't install or show the offline page.
    });
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
