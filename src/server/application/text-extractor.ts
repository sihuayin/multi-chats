import { assertSafeHttpUrl } from "@/server/security/ssrf";

export type SourceTextInput =
  | { kind: "url"; location: string }
  | { kind: "file"; location: string; content: string };

export interface TextExtractor {
  extract(input: SourceTextInput): Promise<string>;
}

export function isPdfLocation(location: string): boolean {
  return location.toLowerCase().endsWith(".pdf");
}

/**
 * Deterministic HTML-to-text fallback. Removes script/style blocks, inserts
 * line breaks at block boundaries, strips remaining tags, and decodes the
 * common character entities. Kept behind the TextExtractor port so a richer
 * HTML parser can replace it without touching the ingestion path.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type DefaultTextExtractorOptions = {
  fetchImpl?: typeof fetch;
  htmlToTextImpl?: (html: string) => string;
  pdfToText?: (content: string) => Promise<string>;
};

export class DefaultTextExtractor implements TextExtractor {
  private readonly fetchImpl: typeof fetch;
  private readonly htmlToTextImpl: (html: string) => string;
  private readonly pdfToText?: (content: string) => Promise<string>;

  constructor(options: DefaultTextExtractorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.htmlToTextImpl = options.htmlToTextImpl ?? htmlToText;
    this.pdfToText = options.pdfToText;
  }

  async extract(input: SourceTextInput): Promise<string> {
    if (input.kind === "url") {
      const url = assertSafeHttpUrl(input.location);
      const response = await this.fetchImpl(url, {
        headers: { "user-agent": "multi-chats/0.1" }
      });
      if (!response.ok) {
        throw new Error(`Fetch failed with HTTP ${response.status}`);
      }
      const text = this.htmlToTextImpl(await response.text()).trim();
      if (!text) {
        throw new Error("Source produced no readable text");
      }
      return text;
    }

    if (isPdfLocation(input.location)) {
      if (!this.pdfToText) {
        throw new Error("PDF extraction is not configured");
      }
      const text = (await this.pdfToText(input.content)).trim();
      if (!text) {
        throw new Error("PDF produced no readable text");
      }
      return text;
    }

    const text = input.content.trim();
    if (!text) {
      throw new Error("Source produced no readable text");
    }
    return text;
  }
}
