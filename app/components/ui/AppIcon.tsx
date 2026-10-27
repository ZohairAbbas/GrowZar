import { cn } from "~/lib/utils";

/** Growzar's icon, the teal hexagon on navy: the vector the installed app's icons are made from. */
export function AppIcon({ className }: { className?: string }) {
  return <img src="/icons/growzar.svg" alt="" width={64} height={64} className={cn("block h-8 w-8 flex-shrink-0", className)} />;
}
