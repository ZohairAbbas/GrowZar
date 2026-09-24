import { cn } from "~/lib/utils";

/**
 * Ported from salvage/components/ui/LoadingSpinner.tsx.
 * Unchanged apart from `cn` and the `currentColor` border, so a spinner inside
 * a dark button is visible — the salvaged one was hardcoded to gray-900 and
 * disappeared on the primary button it was most often used in.
 */
const sizeClasses = {
  sm: "h-4 w-4 border-2",
  md: "h-8 w-8 border-2",
  lg: "h-12 w-12 border-4",
} as const;

export function LoadingSpinner({
  size = "md",
  className,
}: {
  size?: keyof typeof sizeClasses;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center justify-center", className)}>
      <span
        role="status"
        aria-label="Loading"
        className={cn(
          "animate-spin rounded-full border-current border-r-transparent",
          sizeClasses[size],
        )}
      />
    </span>
  );
}
