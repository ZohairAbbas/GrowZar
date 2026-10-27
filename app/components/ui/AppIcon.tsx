import { cn } from "~/lib/utils";

/** Growzar's icon, the teal hexagon on navy (pre-Wave-1 pack 3; the same file the installed app uses). */
export function AppIcon({ className }: { className?: string }) {
  return <img src="/icons/icon-64.png" alt="" width={64} height={64} className={cn("block h-8 w-8 flex-shrink-0", className)} />;
}
