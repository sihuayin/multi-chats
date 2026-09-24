import { afterEach, describe, expect, it } from "vitest";
import {
  getServices,
  setServicesForTests
} from "@/server/application/services";
import { handleApiRequest } from "@/server/http/router";
import { setStoreForTests } from "@/server/store";
import { MemoryStore } from "@/server/store/memory-store";
import { createFixtureState, TEST_KEY } from "@/server/test-support/fixtures";

const PROVIDER_ID = "10000000-0000-4000-8000-000000000001";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalEncryptionKey = process.env.APP_ENCRYPTION_KEY;
const originalModelMode = process.env.MODEL_MODE;

afterEach(() => {
  setServicesForTests(undefined);
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = originalEncryptionKey;
  if (originalModelMode === undefined) delete process.env.MODEL_MODE;
  else process.env.MODEL_MODE = originalModelMode;
});

/**
 * The fixture encrypts its credential with `TEST_KEY`, so the service graph —
 * which builds its cipher from the environment — has to be handed the same key
 * or the test would fail on a decryption it never meant to exercise.
 *
 * `MODEL_MODE=fake` keeps the check off the network: `validateProviderCredential`
 * returns before it calls the Provider, while the credential resolution ahead of
 * that return still runs.
 */
function setup() {
  const store = new MemoryStore(createFixtureState());
  setStoreForTests(store);
  process.env.DATABASE_URL = "postgres://provider-contract";
  process.env.APP_ENCRYPTION_KEY = TEST_KEY;
  process.env.MODEL_MODE = "fake";
  setServicesForTests(getServices());
  return store;
}

describe("Provider contract", () => {
  it("tests a stored Provider and records the validation", async () => {
    const store = setup();
    const before = await store.read(
      (state) => state.providers[0].lastValidatedAt
    );

    const response = await handleApiRequest(
      new Request(`http://localhost/api/providers/${PROVIDER_ID}/test`, {
        method: "POST"
      }),
      ["providers", PROVIDER_ID, "test"]
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      latencyMs: number;
      validatedAt: string;
    };
    expect(body.status).toBe("ok");
    expect(Number.isFinite(body.latencyMs)).toBe(true);
    expect(
      await store.read((state) => state.providers[0].lastValidatedAt)
    ).toBe(body.validatedAt);
    expect(body.validatedAt).not.toBe(before);
  });

  it("refuses a Provider that is not in the Workspace", async () => {
    setup();

    const response = await handleApiRequest(
      new Request("http://localhost/api/providers/absent/test", {
        method: "POST"
      }),
      ["providers", "absent", "test"]
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });
});
