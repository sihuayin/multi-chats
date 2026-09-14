import type { Employee } from "@/server/domain/types";

export function mentionSlug(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .replace(/^-|-$/g, "");
}

export function activeMention(
  value: string,
  caret: number
): { start: number; end: number; query: string } | null {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)@`?([^\s@`]*)(?:`)?$/);
  if (!match) return null;
  return {
    start: beforeCaret.lastIndexOf("@"),
    end: beforeCaret.length,
    query: match[1] ?? ""
  };
}

export function filterMentionEmployees(
  employees: Employee[],
  query: string
): Employee[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return employees;
  return employees.filter((employee) => {
    const slug = mentionSlug(employee.name);
    return (
      employee.name.toLowerCase().includes(normalized) ||
      slug.includes(normalized)
    );
  });
}
