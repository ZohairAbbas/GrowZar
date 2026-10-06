import { NavLink } from "react-router";
import { Building2, CreditCard, Gauge, Scale, Shield, User, Users } from "lucide-react";

import { cn } from "~/lib/utils";

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
    name: "Billing",
    to: "/settings/billing",
    icon: CreditCard,
    description: "Growzar is free (D-06)",
    disabled: true,
  },
];

export function SettingsNav() {
  return (
    <nav className="space-y-1">
      <h2 className="mb-2 px-3 pt-2 font-display text-lg font-bold text-gray-900">
        Settings
      </h2>

      {navigation.map((item) => {
        if (item.disabled) {
          return (
            <span
              key={item.name}
              aria-disabled="true"
              className="group flex cursor-not-allowed items-start gap-3 rounded-xl px-3 py-2.5 text-gray-400"
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
                "group flex items-start gap-3 rounded-xl px-3 py-2.5 transition",
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
                    "mt-0.5 h-5 w-5 flex-shrink-0",
                    isActive
                      ? "text-mint"
                      : "text-gray-400 group-hover:text-gray-600",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{item.name}</span>
                  <span className={cn("mt-0.5 block text-xs", isActive ? "text-navy-muted" : "text-gray-500")}>
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
