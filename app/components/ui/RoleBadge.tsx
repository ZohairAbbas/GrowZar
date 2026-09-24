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
  owner: "bg-red-50 text-red-800 border-red-200",
  admin: "bg-orange-50 text-orange-800 border-orange-200",
  manager: "bg-blue-50 text-blue-800 border-blue-200",
  staff: "bg-gray-100 text-gray-800 border-gray-200",
};

const CUSTOM_ROLE_STYLE = "bg-violet-50 text-violet-800 border-violet-200";

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
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        style,
        className,
      )}
    >
      {label}
    </span>
  );
}
