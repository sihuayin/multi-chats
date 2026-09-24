import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-normal",
  {
    variants: {
      variant: {
        default:
          "border-[var(--emerald-edge)] bg-[var(--accent-soft)] text-[var(--accent-strong)]",
        secondary:
          "border-[var(--border)] bg-[var(--secondary)] text-[var(--secondary-foreground)]",
        destructive:
          "border-[var(--danger-edge)] bg-[var(--danger-soft)] text-[var(--danger)]",
        outline: "border-[var(--border)] text-[var(--foreground)]"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
