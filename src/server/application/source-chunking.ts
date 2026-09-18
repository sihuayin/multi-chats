import { createHash } from "node:crypto";
import type { Chunk } from "@/server/domain/types";

export const DEFAULT_CHUNK_MAX_CHARS = 4_000;

export function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function chunkId(
  sourceId: string,
  index: number,
  hash: string
): string {
  return `chunk-${createHash("sha256")
    .update(`${sourceId}:${index}:${hash}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function hardSplit(block: string, maxChars: number): string[] {
  const parts: string[] = [];
  let remaining = block;
  while (remaining.length > maxChars) {
    parts.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }
  const tail = remaining.trim();
  if (tail) parts.push(tail);
  return parts;
}

/**
 * Deterministic chunking: split at blank-line paragraph boundaries and at
 * Markdown heading starts, so each paragraph or heading section becomes one
 * chunk. A block larger than `maxChars` is hard-split into fixed-size pieces.
 * The same text always yields the same ordered chunk contents.
 */
export function splitText(
  text: string,
  maxChars: number = DEFAULT_CHUNK_MAX_CHARS
): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const blocks = normalized
    .split(/(?:\n{2,})|(?=\n#{1,6}\s)/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.flatMap((block) =>
    block.length > maxChars ? hardSplit(block, maxChars) : [block]
  );
}

export function chunkSource(input: {
  sourceId: string;
  workspaceId: string;
  text: string;
  now: string;
  maxChars?: number;
}): Chunk[] {
  return splitText(input.text, input.maxChars).map((content, index) => {
    const hash = contentHash(content);
    return {
      id: chunkId(input.sourceId, index, hash),
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      index,
      content,
      contentHash: hash,
      createdAt: input.now,
      updatedAt: input.now
    };
  });
}
