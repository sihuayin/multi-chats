import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { I18nProvider } from "@/components/i18n-provider";
import { WorkspaceProvider } from "@/components/workspace-provider";
import { detectLocale, isLocale } from "@/lib/i18n";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const cookieLocale = cookieStore.get("locale")?.value;
  const locale = isLocale(cookieLocale)
    ? cookieLocale
    : detectLocale(requestHeaders.get("accept-language"));
  return {
    title: "Multi-Chats",
    description:
      locale === "zh"
        ? "用于协作管理 AI 员工的自托管工作区。"
        : "A self-hosted workspace for collaborative AI employees."
  };
}

export default async function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const cookieLocale = cookieStore.get("locale")?.value;
  const initialLocale = isLocale(cookieLocale)
    ? cookieLocale
    : detectLocale(requestHeaders.get("accept-language"));

  return (
    <html lang={initialLocale}>
      <body>
        <I18nProvider initialLocale={initialLocale}>
          <WorkspaceProvider>
            <AppShell>{children}</AppShell>
          </WorkspaceProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
