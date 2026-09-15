import { verifyProviderSmokeMatrix } from "@/server/application/provider-smoke-verification";

async function main(): Promise<void> {
  const result = await verifyProviderSmokeMatrix({ env: process.env });
  if (result.status === "skipped") {
    process.stdout.write(`${result.message}\n`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ report: result.report, gate: result.gate }, null, 2)}\n`
  );
  if (result.status === "failed") {
    throw new Error(result.message);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
