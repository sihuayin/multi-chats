export type PaginationEntry = number | "ellipsis";

export function paginationEntries(
  currentPage: number,
  pageCount: number
): PaginationEntry[] {
  if (pageCount <= 5) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const pages = Array.from(
    new Set([
      1,
      pageCount,
      currentPage - 1,
      currentPage,
      currentPage + 1
    ])
  )
    .filter((page) => page >= 1 && page <= pageCount)
    .sort((left, right) => left - right);

  return pages.flatMap((page, index) => {
    const previous = pages[index - 1];
    if (previous && page - previous > 1) {
      return ["ellipsis" as const, page];
    }
    return [page];
  });
}
