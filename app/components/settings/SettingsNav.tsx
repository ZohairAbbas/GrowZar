import { NavLink } from "react-router";
import { BookOpen, Building2, CreditCard, Gauge, Mail, MessageCircleQuestionMark, Scale, Shield, User, Users } from "lucide-react";

import { cn } from "~/lib/utils";
import { useCenterActive } from "~/components/ui/useCenterActive";

/**
 * Ported from salvage/components/settings/SettingsNav.tsx.
 * `next/link` → `NavLink`, `usePathname` → NavLink's own `isActive`, which also
 * removes the salvaged startsWith() prefix matching that lit up two items at
 * once for nested routes.
 */
type NavItem = {
  name: string;
  to: string;
  icon: typeof User;
  description: string;
  end?: boolean;
  disabled?: boolean;
  /** Shown to internal accounts only (a feature in pilot). */
  internal?: boolean;
};

const navigation: NavItem[] = [
  { name: "Personal", to: "/settings", end: true, icon: User, description: "Your account" },
  {
    name: "Organization",
    to: "/settings/organization",
    icon: Building2,
    description: "Name, currency, danger zone",
  },
  {
    name: "Team",
    to: "/settings/team",
    icon: Users,
    description: "Members and invitations",
  },
  {
    name: "Roles",
    to: "/settings/roles",
    icon: Shield,
    description: "Section × action permissions",
  },
  {
    name: "Profit",
    to: "/settings/profit",
    icon: Scale,
    description: "Each store's profit settings",
  },
  {
    name: "Data coverage",
    to: "/settings/coverage",
    icon: Gauge,
    description: "What each app sends, and what is missing",
  },
  {
    name: "Weekly digest",
    to: "/settings/digest",
    icon: Mail,
    description: "Monday's email, preview and log",
  },
  {
    name: "Ask",
    to: "/settings/ask",
    icon: MessageCircleQuestionMark,
    description: "Questions about your data: switch, usage, privacy",
  },
  {
    name: "Books",
    to: "/settings/books",
    icon: BookOpen,
    description: "The organization's switch (pilot)",
    internal: true,
  },
  {
    name: "Billing",
    to: "/settings/billing",
    icon: CreditCard,
    description: "Growzar is free (D-06)",
    disabled: true,
  },
];

export function SettingsNav({ internal = false }: { internal?: boolean }) {
  // A phone gets one row of names that scrolls sideways, so the page itself starts on screen.
  const strip = useCenterActive<HTMLElement>();
  return (
    <nav ref={strip} className="flex gap-1.5 overflow-x-auto sm:block sm:space-y-1">
      <h2 className="mb-2 hidden px-3 pt-2 font-display text-lg font-bold text-gray-900 sm:block">
        Settings
      </h2>

      {navigation.filter((item) => internal || !item.internal).map((item) => {
        if (item.disabled) {
          return (
            <span
              key={item.name}
              aria-disabled="true"
              className="group hidden cursor-not-allowed items-start gap-3 rounded-xl px-3 py-2.5 text-gray-400 sm:flex"
            >
              <item.icon className="mt-0.5 h-5 w-5 flex-shrink-0 text-gray-300" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {item.name}
                  <span className="text-xs font-normal text-gray-400">Soon</span>
                </span>
                <span className="mt-0.5 block text-xs text-gray-400">
                  {item.description}
                </span>
              </span>
            </span>
          );
        }

        return (
          <NavLink
            key={item.name}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "group flex flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2.5 transition max-sm:min-h-11 sm:items-start sm:gap-3 sm:whitespace-normal",
                isActive
                  ? "bg-navy text-white"
                  : "text-gray-700 hover:bg-field hover:text-gray-900",
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className={cn(
                    "h-5 w-5 flex-shrink-0 sm:mt-0.5",
                    isActive
                      ? "text-mint"
                      : "text-gray-400 group-hover:text-gray-600",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{item.name}</span>
                  <span className={cn("mt-0.5 hidden text-xs sm:block", isActive ? "text-navy-muted" : "text-gray-500")}>
                    {item.description}
                  </span>
                </span>
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}
