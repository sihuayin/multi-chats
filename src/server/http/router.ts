import "server-only";

import {
  approvalDecisionSchema,
  discussionConfirmSchema,
  discussionExtendSchema,
  discussionRetrySchema,
  discussionSkipSchema,
  discussionStopSchema,
  discussionSynthesizeSchema,
  emptyCommandSchema
} from "@/server/domain/schemas";
import { ApiError } from "@/server/application/errors";
import { getServices } from "@/server/application/services";
import { logger } from "@/server/observability/logger";
import { getStore } from "@/server/store";
import { discussionEventView } from "@/server/application/discussion-view";

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

async function idempotent(
  request: Request,
  scope: string,
  operation: () => Promise<Response>
): Promise<Response> {
  const key = request.headers.get("idempotency-key");
  if (!key) return operation();
  const pendingKey = `${scope}:${key}`;
  const pending = idempotencyInFlight.get(pendingKey);
  if (pending) return pending.then((response) => response.clone());
  const running = (async () => {
  const store = getStore();
  const existing = await store.read((state) => {
    const now = Date.now();
    const record = (state.idempotencyRecords ?? []).find(
      (item) =>
        item.scope === scope &&
        item.key === key &&
        Date.parse(item.expiresAt) > now
    );
    return record ? structuredClone(record) : null;
  });
    if (existing) {
      return json(existing.body, { status: existing.status });
    }
    const response = await operation();
    if (response.status >= 400) return response;
    const responseBody = await response.clone().json().catch(() => null);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
    await store.update((state) => {
      state.idempotencyRecords ??= [];
      state.idempotencyRecords = state.idempotencyRecords.filter(
        (item) => Date.parse(item.expiresAt) > now.getTime()
      );
      state.idempotencyRecords.push({
        id: crypto.randomUUID(),
        scope,
        key,
        status: response.status,
        body: responseBody,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString()
      });
    });
    return response;
  })();
  idempotencyInFlight.set(pendingKey, running);
  try {
    return await running;
  } finally {
    idempotencyInFlight.delete(pendingKey);
  }
}

const idempotencyInFlight = new Map<string, Promise<Response>>();

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

async function streamDiscussionEvents(
  request: Request,
  discussionId: string
): Promise<Response> {
  const { discussions } = getServices();
  await discussions.getDiscussionView(discussionId);
  const url = new URL(request.url);
  let after = Number(
    url.searchParams.get("afterSequence") ?? 0
  );
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const deadline = Date.now() + 120_000;
      while (!request.signal.aborted && Date.now() < deadline) {
        const [events, view] = await Promise.all([
          discussions.listDiscussionEvents(discussionId, after),
          discussions.getDiscussionView(discussionId)
        ]);
        for (const event of events) {
          after = event.sequence;
          const discussion = await discussions.getDiscussion(discussionId);
          const payload = discussionEventView(event, discussion);
          controller.enqueue(
            encoder.encode(
              `id: ${event.sequence}\ndata: ${JSON.stringify(payload)}\n\n`
            )
          );
        }
        if (
          view.activeRun === undefined &&
          ["completed", "cancelled"].includes(
            view.discussion.status
          )
        ) {
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

async function processDiscussionInBackground(
  runs: ReturnType<typeof getServices>["runs"],
  discussions: ReturnType<typeof getServices>["discussions"],
  discussionId: string
): Promise<void> {
  for (let step = 0; step < 10; step += 1) {
    await discussions.reconcileDiscussions();
    const view = await discussions.getDiscussionView(discussionId);
    if (!view.activeRun) return;
    await runs.processRun(view.activeRun.id);
  }
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

  const { workspace, runs, discussions } = getServices();

  if (request.method === "GET" && resource === "workspace") {
    return json(await workspace.getWorkspaceView());
  }

  if (request.method === "PATCH" && resource === "workspace") {
    return json(await workspace.updateWorkspace(await body(request)));
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
      if (request.method === "DELETE" && id && !child) {
        await workspace.deleteConversation(id);
        return new Response(null, { status: 204 });
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
      if (
        request.method === "GET" &&
        id &&
        child === "discussions"
      ) {
        return json(await discussions.listDiscussionViews(id));
      }
      if (
        request.method === "POST" &&
        id &&
        child === "discussions"
      ) {
        return idempotent(
          request,
          `${id}:create:${request.headers.get("idempotency-key") ?? ""}`,
          async () =>
            json(
              await discussions.createDiscussion(
                id,
                await body(request)
              ),
              { status: 201 }
            )
        );
      }
  }

  if (resource === "discussions") {
    if (request.method === "GET" && id && !child) {
      return json(await discussions.getDiscussionView(id));
    }
    if (request.method === "PATCH" && id && !child) {
      return json(
        await discussions.updateDiscussion(id, await body(request))
      );
    }
    if (
      request.method === "PATCH" &&
      id &&
      child === "constraints"
    ) {
      return idempotent(
        request,
        `${id}:constraints:${request.headers.get("idempotency-key") ?? ""}`,
        async () =>
          json(
            await discussions.addConstraints(
              id,
              await body(request)
            )
          )
      );
    }
    if (
      request.method === "GET" &&
      id &&
      child === "events"
    ) {
      return streamDiscussionEvents(request, id);
    }
    if (
      request.method === "GET" &&
      id &&
      child === "rounds" &&
      grandchild
    ) {
      return json(
        await discussions.getDiscussionRound(id, grandchild)
      );
    }
    if (request.method === "POST" && id && child) {
      return idempotent(
        request,
        `${id}:${child}:${request.headers.get("idempotency-key") ?? ""}`,
        async () => {
          const rawInput = await body(request);
          if (child === "start") {
            emptyCommandSchema.parse(rawInput);
            await discussions.startDiscussion(id);
          } else if (child === "interventions") {
            await discussions.addIntervention(id, rawInput, {
              idempotencyKey:
                request.headers.get("idempotency-key") ?? undefined
            });
          } else if (child === "stop") {
            await discussions.stopDiscussion(
              id,
              discussionStopSchema.parse(rawInput)
            );
          } else if (child === "retry") {
            await discussions.retryPhase(
              id,
              discussionRetrySchema.parse(rawInput)
            );
          } else if (child === "skip") {
            await discussions.skipParticipant(
              id,
              discussionSkipSchema.parse(rawInput)
            );
          } else if (child === "synthesize") {
            await discussions.synthesize(
              id,
              discussionSynthesizeSchema.parse(rawInput)
            );
          } else if (child === "confirm") {
            await discussions.confirmBrief(
              id,
              discussionConfirmSchema.parse(rawInput)
            );
          } else if (child === "cancel") {
            await discussions.cancelDiscussion(
              id,
              discussionStopSchema.parse(rawInput)
            );
          } else if (child === "extend") {
            const extendInput = discussionExtendSchema.parse(rawInput);
            await discussions.extendDiscussion(id, extendInput);
          } else {
            return json(
              { error: "Route not found", code: "not_found" },
              { status: 404 }
            );
          }
          const view = await discussions.getDiscussionView(id);
          if (view.activeRun && !process.env.DATABASE_URL) {
            void processDiscussionInBackground(
              runs,
              discussions,
              id
            );
          }
          const status =
            child === "confirm"
              ? 201
              : ["start", "retry", "synthesize", "extend"].includes(
                    child
                  )
                ? 202
                : 200;
          return json(view, { status });
        }
      );
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
