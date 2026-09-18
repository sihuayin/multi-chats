"use client";

import {
  Activity,
  BookOpen,
  Boxes,
  Bot,
  Braces,
  KeyRound,
  Languages,
  LayoutDashboard,
  LoaderCircle,
  UsersRound,
  Wrench
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useI18n } from "@/components/i18n-provider";
import { useWorkspace } from "@/components/workspace-provider";
import type { TranslationKey } from "@/lib/i18n";

const navItems: Array<{
  href: string;
  label: TranslationKey;
  icon: typeof LayoutDashboard;
}> = [
  { href: "/", label: "nav.conversation", icon: LayoutDashboard },
  { href: "/employees", label: "nav.employees", icon: Bot },
  { href: "/groups", label: "nav.groups", icon: UsersRound },
  { href: "/skills", label: "nav.skills", icon: Braces },
  { href: "/tools", label: "nav.tools", icon: Wrench },
  { href: "/sources", label: "nav.sources", icon: BookOpen },
  { href: "/providers", label: "nav.providers", icon: KeyRound },
  { href: "/diagnostics", label: "nav.diagnostics", icon: Activity }
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data, loading, error } = useWorkspace();
  const { locale, setLocale, t } = useI18n();
  const isProvidersPage = pathname.startsWith("/providers");
  const isSkillsPage = pathname.startsWith("/skills");
  const isSourcesPage = pathname.startsWith("/sources");
  const frameClassName =
    pathname === "/"
      ? "app-frame conversation-layout"
      : isProvidersPage
        ? "app-frame providers-layout"
        : isSkillsPage
          ? "app-frame skills-layout"
          : isSourcesPage
            ? "app-frame sources-layout"
            : "app-frame";

  return (
    <div className={frameClassName}>
      <aside className="app-sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Boxes size={18} />
          </span>
          <div>
            <strong>Multi-Chats</strong>
            <span>{data?.workspace.name ?? t("shell.workspace")}</span>
          </div>
        </div>
        <nav className="primary-nav" aria-label={t("shell.workspaceNav")}>
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
                aria-current={active ? "page" : undefined}
              >
                <Icon size={17} />
                <span>{t(item.label)}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="language-switch" aria-label={t("common.language")}>
            <Languages size={14} />
            <button
              type="button"
              className={locale === "zh" ? "active" : ""}
              aria-pressed={locale === "zh"}
              onClick={() => setLocale("zh")}
            >
              中文
            </button>
            <button
              type="button"
              className={locale === "en" ? "active" : ""}
              aria-pressed={locale === "en"}
              onClick={() => setLocale("en")}
            >
              EN
            </button>
          </div>
          <div className="sidebar-status">
            <span className="status-dot" />
            <span>{loading ? t("shell.connecting") : t("shell.selfHosted")}</span>
          </div>
        </div>
      </aside>
      <main className="app-main">
        {error ? <div className="error-banner">{error}</div> : null}
        {loading && !data ? (
          <div className="empty-state">
            <LoaderCircle className="spin" size={20} />
            <span>{t("shell.loading")}</span>
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
