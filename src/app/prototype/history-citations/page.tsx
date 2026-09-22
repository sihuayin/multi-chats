import { HistoryCitationsPrototype } from "@/components/prototype/history-citations/history-citations-prototype";

/**
 * Throwaway route for #195 on map #188. Not part of the product.
 * See /prototype/history-citations?variant=A|B|C
 */
export default async function HistoryCitationsPrototypePage({
  searchParams
}: {
  searchParams: Promise<{ variant?: string | string[] }>;
}) {
  const params = await searchParams;
  const variant = Array.isArray(params.variant) ? params.variant[0] : params.variant;
  return <HistoryCitationsPrototype initialVariant={variant ?? "A"} />;
}
