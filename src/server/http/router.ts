import "server-only";

import { approvalDecisionSchema } from "@/server/domain/schemas";
import { ApiError } from "@/server/application/errors";
import { getServices } from "@/server/application/services";
import { logger } from "@/server/observability/logger";
import { getStore } from "@/server/store";

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) {
    return json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof Error && error.name === "ZodError") {
    return json(
      { error: "Request validation failed", code: "validation_error", details: error },
      { status: 400 }
    );
  }
  logger.error("http.request.failed", {
    requestId,
    message: error instanceof Error ? error.message : String(error)
  });
  return json(
    {
      error: error instanceof Error ? error.message : "Unexpected server error",
      code: "internal_error"
    },
    { status: 500 }
  );
}

async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "Request body must be valid JSON", "invalid_json");
  }
}

async function health(): Promise<Response> {
  try {
    const store = getStore();
    const state = await store.read((current) => ({
      workspaceId: current.workspace.id,
      heartbeatAt: current.workspace.workerHeartbeatAt
    }));
    const heartbeatAge = state.heartbeatAt
      ? Date.now() - new Date(state.heartbeatAt).getTime()
      : Number.POSITIVE_INFINITY;
    return json({
      status:
        heartbeatAge < 15_000 || !process.env.DATABASE_URL ? "ok" : "degraded",
      database: "ok",
      worker:
        heartbeatAge < 15_000
          ? "ok"
          : !process.env.DATABASE_URL
            ? "inline"
            : "stale",
      workspaceId: state.workspaceId
    });
  } catch (error) {
    logger.error("health.database.failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json(
      {
        status: "unavailable",
        database: "error",
        worker: "unknown"
      },
      { status: 503 }
    );
  }
}

async function streamRunEvents(
  request: Request,
  runId: string
): Promise<Response> {
  const { runs } = getServices();
  const url = new URL(request.url);
  let after = Number(url.searchParams.get("after") ?? 0);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const deadline = Date.now() + 120_000;
      while (!request.signal.aborted && Date.now() < deadline) {
        const events = await runs.listRunEvents(runId, after);
        for (const event of events) {
          after = event.sequence;
          controller.enqueue(
            encoder.encode(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
          );
        }
        const run = await runs.getRunById(runId);
        if (!run) {
          controller.close();
          return;
        }
        if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
          controller.close();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}

async function handleApiRoute(
  request: Request,
  segments: string[],
  requestId: string
): Promise<Response> {
  const [resource, id, child, grandchild] = segments;

  if (request.method === "GET" && resource === "health") {
    return health();
  }

  const { workspace, runs } = getServices();

  if (request.method === "GET" && resource === "workspace") {
    return json(await workspace.getWorkspaceView());
  }

  if (resource === "providers") {
      if (request.method === "GET" && !id) {
        return json(await workspace.listProviders());
      }
      if (request.method === "POST" && !id) {
        return json(await workspace.createProvider(await body(request)), {
          status: 201
        });
      }
      if (request.method === "PUT" && id) {
        return json(await workspace.updateProvider(id, await body(request)));
      }
      if (request.method === "DELETE" && id) {
        await workspace.deleteProvider(id);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && id && child === "models") {
        return json(await workspace.listProviderModels(id));
      }
  }

  if (resource === "employees") {
      if (request.method === "POST" && !id) {
        return json(await workspace.createEmployee(await body(request)), {
          status: 201
        });
      }
      if (request.method === "PUT" && id) {
        return json(await workspace.updateEmployee(id, await body(request)));
      }
  }

  if (resource === "skills") {
      if (request.method === "POST" && !id) {
        return json(await workspace.createSkill(await body(request)), {
          status: 201
        });
      }
      if (request.method === "PUT" && id) {
        return json(await workspace.updateSkill(id, await body(request)));
      }
  }

  if (resource === "groups") {
      if (request.method === "POST" && !id) {
        return json(await workspace.createGroup(await body(request)), {
          status: 201
        });
      }
      if (request.method === "PUT" && id) {
        return json(await workspace.updateGroup(id, await body(request)));
      }
  }

  if (resource === "conversations") {
      if (request.method === "POST" && !id) {
        return json(await workspace.createConversation(await body(request)), {
          status: 201
        });
      }
      if (request.method === "PATCH" && id && !child) {
        const parsed = (await body(request)) as { memberIds?: string[] };
        if (!Array.isArray(parsed.memberIds)) {
          throw new ApiError(400, "memberIds is required", "validation_error");
        }
        return json(await workspace.updateConversationMembers(id, parsed.memberIds));
      }
      if (request.method === "GET" && id && child === "messages") {
        return json(await runs.listMessages(id));
      }
      if (request.method === "POST" && id && child === "messages") {
        const result = await runs.startTurn(id, await body(request), {
          requestId
        });
        if (result.run && !process.env.DATABASE_URL) {
          void runs.processRun(result.run.id);
        }
        return json(result, { status: 202 });
      }
      if (request.method === "POST" && id && child === "tasks") {
        return json(await workspace.createTask(id, await body(request)), {
          status: 201
        });
      }
  }

  if (resource === "runs") {
      if (request.method === "DELETE" && id && !child) {
        return json(await runs.cancelRun(id));
      }
      if (request.method === "POST" && id && child === "resume") {
        return json(await runs.resumeRun(id));
      }
      if (request.method === "GET" && id && child === "events") {
        return streamRunEvents(request, id);
      }
  }

  if (resource === "tasks") {
      if (request.method === "PATCH" && id && !child) {
        return json(await workspace.updateTask(id, await body(request), "user"));
      }
      if (request.method === "POST" && id && child === "artifacts") {
        return json(await workspace.createArtifact(id, await body(request)), {
          status: 201
        });
      }
      if (
        request.method === "PATCH" &&
        id &&
        child === "artifacts" &&
        grandchild
      ) {
        return json(
          await workspace.updateArtifact(
            id,
            grandchild,
            await body(request),
            "user"
          )
        );
      }
  }

  if (resource === "approvals") {
      if (request.method === "PATCH" && id) {
        const parsed = approvalDecisionSchema.parse(await body(request));
        return json(await workspace.resolveApproval(id, parsed.decision));
      }
  }

  return json({ error: "Route not found", code: "not_found" }, { status: 404 });
}

export async function handleApiRequest(
  request: Request,
  segments: string[]
): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const response = await handleApiRoute(request, segments, requestId);
    response.headers.set("x-request-id", requestId);
    logger.info("http.request.completed", {
      requestId,
      method: request.method,
      path: `/${segments.join("/")}`,
      status: response.status,
      durationMs: Date.now() - startedAt
    });
    return response;
  } catch (error) {
    const response = errorResponse(error, requestId);
    response.headers.set("x-request-id", requestId);
    logger.warn("http.request.rejected", {
      requestId,
      method: request.method,
      path: `/${segments.join("/")}`,
      status: response.status,
      durationMs: Date.now() - startedAt
    });
    return response;
  }
}
