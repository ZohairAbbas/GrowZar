import { useEffect, useState } from "react";
import { Bell, BellOff, Send } from "lucide-react";

import { keyBytes, notificationState, sameKey, type NotificationState } from "~/lib/push/browser";

/**
 * Settings → Personal's Notifications (pre-Wave-1 pack 4). Per device: the
 * switch says whether this browser gets Growzar's pushes. Permission is asked
 * only when the merchant presses "Turn on".
 */

const post = (body: Record<string, string>) => fetch("/api/push", { method: "POST", body: new URLSearchParams(body) });

async function registration() {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

async function readState(publicKey: string): Promise<NotificationState> {
  const supported = "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;
  const reg = supported ? await registration() : null;
  let sub = reg ? await reg.pushManager.getSubscription() : null;
  // Made with an older key: it can't be sent to, so it goes, and the switch reads off.
  if (sub && !sameKey(sub.options.applicationServerKey, publicKey)) {
    await sub.unsubscribe().catch(() => null);
    sub = null;
  }
  // The server's copy may have been dropped (a 410); this puts it back.
  if (sub && Notification.permission === "granted") void post({ intent: "subscribe", subscription: JSON.stringify(sub) });
  return notificationState({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone:
      window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    supported: supported && reg !== null,
    permission: supported ? Notification.permission : "default",
    subscribed: sub !== null,
  });
}

const TEXT: Record<Exclude<NotificationState, "loading">, string> = {
  unsupported: "This browser can't show notifications from Growzar. Chrome or Edge on Android and on a computer can.",
  ios_install:
    "On iPhone and iPad, notifications work once Growzar is installed: tap Share, then Add to Home Screen. Open Growzar from your Home Screen and turn them on here.",
  blocked: "Notifications from Growzar are blocked in this browser's settings. Allow them there, then turn them on here.",
  off: "Off on this device.",
  on: "On for this device.",
};

export function NotificationsSetting({ publicKey, live }: { publicKey: string; live: boolean }) {
  const [state, setState] = useState<NotificationState>("loading");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void readState(publicKey).then(setState, () => setState("unsupported"));
  }, [publicKey]);

  async function turnOn() {
    setBusy(true);
    setNote(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const reg = await registration();
      if (!reg) {
        setState("unsupported");
        return;
      }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      const saved = await post({ intent: "subscribe", subscription: JSON.stringify(sub) });
      if (!saved.ok) {
        await sub.unsubscribe().catch(() => null);
        setNote("Growzar couldn't save this device. Try again in a minute.");
        return;
      }
      setState("on");
    } catch {
      setNote("This browser wouldn't turn notifications on.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setNote(null);
    try {
      const sub = await (await registration())?.pushManager.getSubscription();
      if (sub) {
        await post({ intent: "unsubscribe", endpoint: sub.endpoint });
        await sub.unsubscribe().catch(() => null);
      }
      setState("off");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNote(null);
    try {
      const r = await post({ intent: "test" });
      const body = r.ok ? ((await r.json()) as { test?: { status: string } }) : null;
      setNote(body?.test?.status === "sent" ? "Sent. It should arrive in a few seconds." : "It didn't go through. Turn notifications off and on again, then retry.");
    } finally {
      setBusy(false);
    }
  }

  const button = "tap inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50";
  return (
    <section className="rounded-2xl bg-white p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gray-100">
          <Bell className="h-5 w-5 text-gray-600" />
        </span>
        <div>
          <h2 className="font-display text-lg font-bold text-gray-900">Notifications</h2>
          <p className="text-sm text-gray-600">
            Growzar tells you when something needs you: a courier payout running late, your store's top finding of the day, and on Mondays,
            Books entries waiting for approval and your weekly digest. At most 2 a day, never between 22:00 and 08:00.
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-gray-700">{state === "loading" ? "Checking this device…" : TEXT[state]}</p>
        {state === "off" || state === "on" ? (
          <div className="flex flex-wrap gap-2">
            {state === "on" ? (
              <button type="button" onClick={test} disabled={busy} className={`${button} bg-field text-gray-700 hover:bg-gray-100`}>
                <Send className="h-4 w-4" /> Send a test
              </button>
            ) : null}
            <button
              type="button"
              onClick={state === "on" ? turnOff : turnOn}
              disabled={busy}
              className={`${button} ${state === "on" ? "bg-field text-gray-700 hover:bg-gray-100" : "bg-navy text-white hover:bg-navy-surface"}`}
            >
              {state === "on" ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
              {state === "on" ? "Turn off" : "Turn on"}
            </button>
          </div>
        ) : null}
      </div>
      {note ? <p className="mt-3 text-sm text-gray-600">{note}</p> : null}
      {!live ? <p className="mt-3 text-xs text-gray-500">Internal: sending is off for your account, so only "Send a test" arrives. The rest is logged as dry runs.</p> : null}
    </section>
  );
}
