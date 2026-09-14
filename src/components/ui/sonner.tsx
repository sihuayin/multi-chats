"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast bg-[var(--popover)] text-[var(--popover-foreground)] border-[var(--border)] shadow-lg",
          description: "text-[var(--muted-foreground)]",
          actionButton:
            "bg-[var(--primary)] text-[var(--primary-foreground)]",
          cancelButton:
            "bg-[var(--muted)] text-[var(--muted-foreground)]"
        }
      }}
      {...props}
    />
  );
}

export { Toaster };
