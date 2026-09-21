"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Throwaway floating switcher shared by prototype routes.
 * Not part of the product; renders nothing in production builds.
 */
export function PrototypeSwitcher({
  variants,
  labels,
  current
}: {
  variants: string[];
  labels: Record<string, string>;
  current: string;
}) {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) {
        return;
      }
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function go(next: string) {
    const params = new URLSearchParams(window.location.search);
    params.set("variant", next);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  function step(delta: number) {
    const index = variants.indexOf(current);
    const next = variants[(index + delta + variants.length) % variants.length];
    go(next);
  }

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 20,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 16px",
        borderRadius: 999,
        background: "#101014",
        color: "#f5f5f5",
        boxShadow: "0 12px 40px rgb(0 0 0 / 0.45)",
        font: "500 13px/1.2 ui-sans-serif, system-ui, sans-serif"
      }}
    >
      <button
        type="button"
        aria-label="Previous variant"
        onClick={() => step(-1)}
        style={arrowStyle}
      >
        ←
      </button>
      <span style={{ minWidth: 210, textAlign: "center" }}>
        {current} · {labels[current] ?? ""}
      </span>
      <button
        type="button"
        aria-label="Next variant"
        onClick={() => step(1)}
        style={arrowStyle}
      >
        →
      </button>
    </div>
  );
}

const arrowStyle = {
  border: "1px solid rgb(255 255 255 / 0.25)",
  background: "transparent",
  color: "inherit",
  borderRadius: 999,
  width: 28,
  height: 28,
  cursor: "pointer",
  font: "inherit"
} as const;
