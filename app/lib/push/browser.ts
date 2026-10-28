import { isIos } from "../install-app";

/**
 * Settings' Notifications switch, in the browser (pre-Wave-1 pack 4). The
 * browser is asked for permission only when the merchant turns it on, never
 * on load. On iPhone and iPad, pushes reach Growzar only once it is installed
 * to the Home Screen (iOS 16.4 or later), so there the switch says that first.
 */
export type NotificationState = "loading" | "unsupported" | "ios_install" | "blocked" | "off" | "on";

/** The rule, apart from the browser so it can be tested. */
export function notificationState(device: {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  supported: boolean;
  permission: "default" | "granted" | "denied";
  subscribed: boolean;
}): NotificationState {
  if (isIos(device.userAgent, device.maxTouchPoints) && !device.standalone) return "ios_install";
  if (!device.supported) return "unsupported";
  if (device.permission === "denied") return "blocked";
  return device.subscribed && device.permission === "granted" ? "on" : "off";
}

/** A VAPID public key (URL-safe base64) as the bytes `pushManager.subscribe` wants. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Does a subscription use this key? One made with an older key can't be sent to. */
export function sameKey(subscriptionKey: ArrayBuffer | null, publicKey: string): boolean {
  if (!subscriptionKey) return false;
  const a = new Uint8Array(subscriptionKey);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
