import { ROLE_LABELS, type RoleName } from "~/lib/permissions";
import { cn } from "~/lib/utils";

/**
 * Ported from salvage/components/ui/RoleBadge.tsx, with its role list replaced.
 * The salvaged one knew owner/admin/manager/analyst/viewer; Growzar's roles are
 * owner/admin/manager/staff plus whatever custom roles an organization creates
 * (D-12), so an unknown name renders as itself rather than silently displaying
 * "Viewer" — the salvaged component's fallback, which would have shown a custom
 * role under the wrong name.
 */
const roleStyles: Record<string, string> = {
  owner: "bg-navy text-mint border-navy",
  admin: "bg-mint-100 text-mint-700 border-mint-100",
  manager: "bg-data-100 text-data-700 border-data-100",
  staff: "bg-field text-gray-700 border-field",
};

const CUSTOM_ROLE_STYLE = "bg-coral-50 text-coral-700 border-coral-50";

export function RoleBadge({
  role,
  className,
}: {
  role: string;
  className?: string;
}) {
  const key = role.toLowerCase();
  const style = roleStyles[key] ?? CUSTOM_ROLE_STYLE;
  const label = ROLE_LABELS[key as RoleName]?.label ?? role;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        style,
        className,
      )}
    >
      {label}
    </span>
  );
}
