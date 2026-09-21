import { CitationsPrototype } from "@/components/prototype/citations/citations-prototype";

/**
 * Throwaway route for #171 on map #162. Not part of the product.
 * See /prototype/citations?variant=A|B|C
 */
export default async function CitationsPrototypePage({
  searchParams
}: {
  searchParams: Promise<{ variant?: string | string[] }>;
}) {
  const params = await searchParams;
  const variant = Array.isArray(params.variant) ? params.variant[0] : params.variant;
  return <CitationsPrototype initialVariant={variant ?? "A"} />;
}
