/**
 * The citation grammar, shared by the server resolver and the Conversation
 * renderer so one alias means one thing on both sides: the model copies an
 * alias out of a search result and writes it in square brackets where it
 * used the chunk. The six prefixes are the evidence resolver's kinds; this
 * pattern only finds candidates — whether one resolves is the scope's
 * judgement, never the pattern's.
 */
export const CITATION_PATTERN =
  /\[((?:message|turn|task|artifact|tool_result|external):[^\[\]\s]+)\]/g;

/** The render model: a Message body interleaves prose and citations. */
export type CitationPart = { text: string } | { alias: string };

/** Split a Message body into prose and alias parts, in order. */
export function splitCitationParts(content: string): CitationPart[] {
  const parts: CitationPart[] = [];
  let cursor = 0;
  for (const match of content.matchAll(CITATION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: content.slice(cursor, index) });
    parts.push({ alias: match[1] });
    cursor = index + match[0].length;
  }
  if (cursor < content.length) parts.push({ text: content.slice(cursor) });
  return parts;
}

/** Aliases cited in a Message body, deduped in order of first appearance. */
export function citationAliasesIn(content: string): string[] {
  const aliases: string[] = [];
  for (const match of content.matchAll(CITATION_PATTERN)) {
    if (!aliases.includes(match[1])) aliases.push(match[1]);
  }
  return aliases;
}
