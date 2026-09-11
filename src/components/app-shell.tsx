"use client";

import {
  Boxes,
  Bot,
  Braces,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  UsersRound,
  Wrench
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useWorkspace } from "@/components/workspace-provider";

const navItems = [
  { href: "/", label: "Chat", icon: LayoutDashboard },
  { href: "/employees", label: "Employees", icon: Bot },
  { href: "/groups", label: "Groups", icon: UsersRound },
  { href: "/skills", label: "Skills", icon: Braces },
  { href: "/tools", label: "Tools", icon: Wrench },
  { href: "/providers", label: "Providers", icon: KeyRound }
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data, loading, error } = useWorkspace();

  return (
    <div className="app-frame">
      <aside className="app-sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Boxes size={18} />
          </span>
          <div>
            <strong>Multi-Chats</strong>
            <span>{data?.workspace.name ?? "Workspace"}</span>
          </div>
        </div>
        <nav className="primary-nav" aria-label="Workspace">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "nav-item active" : "nav-item"}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-status">
          <span className="status-dot" />
          <span>{loading ? "Connecting" : "Self-hosted"}</span>
        </div>
      </aside>
      <main className="app-main">
        {error ? <div className="error-banner">{error}</div> : null}
        {loading && !data ? (
          <div className="empty-state">
            <LoaderCircle className="spin" size={20} />
            <span>Loading Workspace</span>
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
