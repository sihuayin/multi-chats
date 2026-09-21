import { afterEach, describe, expect, it } from "vitest";
import {
  getServices,
  setServicesForTests
} from "@/server/application/services";
import { handleApiRequest } from "@/server/http/router";
import { setStoreForTests } from "@/server/store";
import { MemoryStore } from "@/server/store/memory-store";
import { createFixtureState } from "@/server/test-support/fixtures";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  setServicesForTests(undefined);
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function setup() {
  const store = new MemoryStore(createFixtureState());
  setStoreForTests(store);
  process.env.DATABASE_URL = "postgres://tool-contract";
  setServicesForTests(getServices());
  return store;
}

const draft = {
  name: "home_status",
  label: "Home Assistant status",
  description: "Read a Home Assistant entity state.",
  risk: "read",
  requiresApproval: false,
  replay: "safe",
  inputSchema: { type: "object", properties: {} },
  request: {
    method: "GET",
    urlTemplate: "http://nas.local:8123/api/states/{entity}"
  },
  credential: "super-secret-token"
};

/** The path and the segments must agree: the router reads the id from the
 *  segments, not from the URL. */
function call(method: string, path: string, body?: unknown) {
  const segments = path.replace(/^\/api\//, "").split("/").filter(Boolean);
  return handleApiRequest(
    new Request(`http://localhost${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          })
    }),
    segments
  );
}

describe("Tool registry contract", () => {
  it("registers a Tool and never returns its credential", async () => {
    setup();

    const created = await call("POST", "/api/tools", draft);
    expect(created.status).toBe(201);

    const listed = await handleApiRequest(
      new Request("http://localhost/api/workspace"),
      ["workspace"]
    );
    const payload = await listed.text();
    expect(payload).toContain("home_status");
    expect(payload).not.toContain("super-secret-token");
    expect(payload).toContain('"configured":true');
  });

  it("refuses a creation with no approval decision", async () => {
    setup();
    const { requiresApproval, ...withoutDecision } = draft;

    const response = await call("POST", "/api/tools", withoutDecision);

    expect(response.status).toBe(400);
  });

  it("refuses to edit or delete a built-in, even by direct request", async () => {
    const store = setup();
    const builtIn = store.snapshot().tools.find((tool) => tool.builtIn);

    const edited = await call("PUT", `/api/tools/${builtIn?.id}`, {
      ...draft,
      name: builtIn?.name
    });
    expect(edited.status).toBe(409);
    expect((await edited.json()).code).toBe("builtin_tool");

    const deleted = await call("DELETE", `/api/tools/${builtIn?.id}`);
    expect(deleted.status).toBe(409);
    expect((await deleted.json()).code).toBe("builtin_tool");
  });

  it("refuses to delete a Tool a Skill still allows", async () => {
    setup();
    const created = await (await call("POST", "/api/tools", draft)).json();

    await handleApiRequest(
      new Request("http://localhost/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Home",
          description: "Reads the house.",
          instructions: "Report the entity state.",
          inputs: ["entity"],
          outputs: ["state"],
          toolNames: ["home_status"]
        })
      }),
      ["skills"]
    );

    const response = await call("DELETE", `/api/tools/${created.id}`);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("tool_in_use");
    expect(body.error).toContain("Home");
  });
});
