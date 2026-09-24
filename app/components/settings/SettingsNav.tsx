import { NavLink } from "react-router";
import { Building2, CreditCard, User, Users } from "lucide-react";

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
      <h2 className="mb-4 px-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
        Settings
      </h2>

      {navigation.map((item) => {
        if (item.disabled) {
          return (
            <span
              key={item.name}
              aria-disabled="true"
              className="group flex cursor-not-allowed items-start gap-3 rounded-lg px-3 py-2.5 text-gray-400"
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
                "group flex items-start gap-3 rounded-lg px-3 py-2.5 transition",
                isActive
                  ? "bg-primary-50 text-primary-700"
                  : "text-gray-700 hover:bg-gray-50 hover:text-gray-900",
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className={cn(
                    "mt-0.5 h-5 w-5 flex-shrink-0",
                    isActive
                      ? "text-primary-600"
                      : "text-gray-400 group-hover:text-gray-600",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.name}</span>
                  <span className="mt-0.5 block text-xs text-gray-500">
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
