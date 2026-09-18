import type { Chunk } from "@/server/domain/types";
import { z } from "zod";
import { parseJsonObject } from "@/server/application/structured-output";
import { rankChunks } from "@/server/application/source-retrieval";

export const RERANK_CANDIDATE_COUNT = 20;

const rerankOrderSchema = z.object({ order: z.array(z.string()) });

/**
 * Parse a re-rank response into the ordered chunk ids. Validating that the
 * result is a permutation of the requested ids happens in `rerankChunkOrder`.
 */
export function parseRerankOrder(raw: string): string[] {
  const parsed = rerankOrderSchema.safeParse(
    parseJsonObject(raw, "Rerank")
  );
  if (!parsed.success) {
    throw new Error("Rerank response is not a valid order");
  }
  return parsed.data.order;
}

/**
 * Re-rank the baseline chunk order by a model-provided permutation of the
 * top-K candidates. `reorder` is injected so the core is testable without a
 * gateway: it receives the top-K chunk ids (in baseline order) and returns a
 * permutation of those ids. Any failure — a throw, or a result that is not a
 * permutation of the top ids — falls back to the baseline order silently.
 */
export async function rerankChunkOrder(input: {
  chunks: Chunk[];
  query: string;
  reorder: (topIds: string[]) => Promise<string[]>;
}): Promise<Chunk[]> {
  const baseline = rankChunks(input.chunks, input.query);
  const top = baseline.slice(0, RERANK_CANDIDATE_COUNT);
  if (top.length < 2) return baseline;

  const topIds = top.map((chunk) => chunk.id);
  let order: string[];
  try {
    order = await input.reorder(topIds);
  } catch {
    return baseline;
  }
  if (!isPermutation(order, topIds)) return baseline;

  const rankById = new Map(order.map((id, index) => [id, index]));
  const rest = baseline.slice(RERANK_CANDIDATE_COUNT);
  const reorderedTop = [...top].sort(
    (left, right) =>
      (rankById.get(left.id) ?? 0) - (rankById.get(right.id) ?? 0)
  );
  return [...reorderedTop, ...rest];
}

function isPermutation(order: string[], ids: string[]): boolean {
  if (order.length !== ids.length) return false;
  const seen = new Set<string>();
  for (const id of order) {
    if (!ids.includes(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}
