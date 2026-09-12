import { spawnSync } from "node:child_process";

const baseUrl = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const composeProject = process.env.VERIFY_COMPOSE_PROJECT;

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    env: process.env,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`
    );
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

async function waitForHealth(): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const health = await request<Record<string, unknown>>("/api/health");
      if (health.status === "ok") return health;
    } catch {
      // The deployment may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Deployment health check did not become ready");
}

type WorkspaceView = {
  groups: Array<{ name: string }>;
  runs: Array<{ conversationId: string; status: string }>;
};

async function verifyWorkspace(): Promise<WorkspaceView> {
  const workspace = await request<WorkspaceView>("/api/workspace");
  const activeByConversation = new Map<string, number>();
  for (const run of workspace.runs) {
    if (!["queued", "running", "waiting_approval"].includes(run.status)) continue;
    const active = (activeByConversation.get(run.conversationId) ?? 0) + 1;
    if (active > 1) {
      throw new Error(
        `Conversation ${run.conversationId} has more than one active Run`
      );
    }
    activeByConversation.set(run.conversationId, active);
  }
  return workspace;
}

async function verifyBackupRestore(): Promise<void> {
  if (!composeProject) return;
  const marker = `deployment-verify-${Date.now()}`;
  await request("/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: marker, memberIds: [] })
  });
  run("docker", [
    "compose",
    "-p",
    composeProject,
    "exec",
    "-T",
    "web",
    "npm",
    "run",
    "db:backup",
    "--",
    "/tmp/deployment-verify-backup.json"
  ]);
  await request("/api/groups", {
    method: "POST",
    body: JSON.stringify({
      name: "remove-after-deployment-restore",
      memberIds: []
    })
  });
  run("docker", [
    "compose",
    "-p",
    composeProject,
    "exec",
    "-T",
    "web",
    "npm",
    "run",
    "db:restore",
    "--",
    "/tmp/deployment-verify-backup.json"
  ]);
  const workspace = await verifyWorkspace();
  const names = workspace.groups.map((group) => group.name);
  if (!names.includes(marker)) throw new Error("Backup marker was not restored");
  if (names.includes("remove-after-deployment-restore")) {
    throw new Error("Post-backup state survived restore");
  }
}

async function main(): Promise<void> {
  if (composeProject && process.env.VERIFY_COMPOSE_START === "1") {
    run("docker", [
      "compose",
      "-p",
      composeProject,
      "up",
      "-d",
      "--build"
    ]);
  }
  const health = await waitForHealth();
  await verifyWorkspace();
  await verifyBackupRestore();

  if (composeProject) {
    run("docker", [
      "compose",
      "-p",
      composeProject,
      "restart",
      "web",
      "worker"
    ]);
    await waitForHealth();
    const logs = spawnSync(
      "docker",
      [
        "compose",
        "-p",
        composeProject,
        "logs",
        "--no-color",
        "web",
        "worker"
      ],
      { encoding: "utf8" }
    );
    if (logs.status !== 0) throw new Error(logs.stderr);
    if (
      logs.stdout.includes("Unhandled") ||
      logs.stdout.includes("UnhandledPromiseRejection")
    ) {
      throw new Error("Deployment logs contain an unhandled error");
    }
  }

  console.log(
    JSON.stringify({
      baseUrl,
      health,
      composeProject: composeProject ?? null,
      backupRestore: composeProject ? "ok" : "skipped",
      activeRunInvariant: "ok"
    })
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
