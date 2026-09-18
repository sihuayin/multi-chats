import { describe, expect, it } from "vitest";
import { DefaultTextExtractor } from "@/server/application/text-extractor";

describe("DefaultTextExtractor", () => {
  it("extracts text from an HTTPS URL behind the SSRF guard", async () => {
    const extractor = new DefaultTextExtractor({
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          text: async () => "<h1>Title</h1><p>Body text.</p>"
        }) as unknown as Response) as typeof fetch,
      htmlToTextImpl: (html) =>
        html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    });

    const text = await extractor.extract({
      kind: "url",
      location: "https://example.com/article"
    });
    expect(text).toBe("Title Body text.");
  });

  it("rejects private-network URLs during URL extraction", async () => {
    const extractor = new DefaultTextExtractor({
      fetchImpl: (async () => {
        throw new Error("should not fetch");
      }) as typeof fetch
    });

    await expect(
      extractor.extract({ kind: "url", location: "http://192.168.1.1/doc" })
    ).rejects.toThrow("Private network URLs are not allowed");
  });

  it("routes PDF files to the isolated pdfToText port", async () => {
    const extractor = new DefaultTextExtractor({
      pdfToText: async (content) => {
        expect(content).toBe("base64-pdf-bytes");
        return "Extracted PDF text.";
      }
    });

    const text = await extractor.extract({
      kind: "file",
      location: "report.pdf",
      content: "base64-pdf-bytes"
    });
    expect(text).toBe("Extracted PDF text.");
  });

  it("treats non-PDF file content as already-extracted text", async () => {
    const extractor = new DefaultTextExtractor();
    const text = await extractor.extract({
      kind: "file",
      location: "notes.md",
      content: "# Heading\n\nBody."
    });
    expect(text).toBe("# Heading\n\nBody.");
  });

  it("rejects empty extracted text", async () => {
    const extractor = new DefaultTextExtractor();
    await expect(
      extractor.extract({ kind: "file", location: "empty.md", content: "   " })
    ).rejects.toThrow("no readable text");
  });
});
