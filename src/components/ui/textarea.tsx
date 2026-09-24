import * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-20 w-full rounded-[var(--radius-btn)] border border-[var(--input)] bg-[var(--field)] px-3 py-2 text-sm transition-all duration-150 ease-out placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:border-[var(--ring)] focus-visible:ring-1 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
