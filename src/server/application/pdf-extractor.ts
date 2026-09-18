import { extractText } from "unpdf";

/**
 * Isolated PDF text extraction behind the TextExtractor port. No other module
 * depends on the PDF parser: this is the only import site for `unpdf`, so the
 * risky external parsing stays swappable and testable without a real PDF.
 *
 * `content` is the PDF bytes as a base64 string.
 */
export async function extractPdfText(content: string): Promise<string> {
  let text: string;
  try {
    const result = await extractText(content, { mergePages: true });
    text = result.text.trim();
  } catch (error) {
    throw new Error(
      `PDF extraction failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!text) {
    throw new Error("PDF produced no readable text");
  }
  return text;
}
