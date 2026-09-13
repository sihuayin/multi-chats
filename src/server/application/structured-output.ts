export function parseJsonObject(raw: string, label: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`${label} response is not JSON`);
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error(`${label} response is not JSON`);
  }
}
