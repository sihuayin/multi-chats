import { EgressPrototype } from "@/components/prototype/egress/egress-prototype";

export default async function EgressPrototypePage({
  searchParams
}: {
  searchParams: Promise<{ variant?: string | string[] }>;
}) {
  const params = await searchParams;
  const variant = Array.isArray(params.variant) ? params.variant[0] : params.variant;
  return <EgressPrototype initialVariant={variant ?? "A"} />;
}
