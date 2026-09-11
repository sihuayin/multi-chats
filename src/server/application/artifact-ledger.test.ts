import { describe, expect, it } from "vitest";
import {
  createTaskArtifact,
  updateTaskArtifact
} from "@/server/application/artifact-ledger";
import type { AppState, Task } from "@/server/domain/types";
import { createFixtureState } from "@/server/test-support/fixtures";

function createTask(state: AppState): Task {
  const task: Task = {
    id: "60000000-0000-4000-8000-000000000001",
    workspaceId: state.workspace.id,
    conversationId: "30000000-0000-4000-8000-000000000001",
    title: "Publish Artifacts",
    goal: "Persist structured results.",
    assigneeIds: ["20000000-0000-4000-8000-000000000001"],
    status: "draft",
    history: [
      {
        status: "draft",
        at: state.workspace.createdAt,
        actorId: "user"
      }
    ],
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt
  };
  state.tasks.push(task);
  return task;
}

describe("Artifact Ledger", () => {
  it("creates and updates supported Artifacts in Task history", () => {
    const state = createFixtureState();
    const task = createTask(state);
    const artifact = createTaskArtifact(
      state,
      task.id,
      {
        type: "markdown",
        name: "Brief",
        content: "# Draft"
      },
      "user"
    );

    const updated = updateTaskArtifact(
      state,
      task.id,
      artifact.id,
      {
        name: "Final brief",
        content: "# Final"
      },
      "user"
    );

    expect(updated).toMatchObject({
      id: artifact.id,
      taskId: task.id,
      type: "markdown",
      name: "Final brief",
      content: "# Final"
    });
    expect(task.history.map((entry) => entry.action)).toEqual([
      undefined,
      "artifact_created",
      "artifact_updated"
    ]);
    expect(task.history.slice(1).map((entry) => entry.artifactId)).toEqual([
      artifact.id,
      artifact.id
    ]);
  });

  it("rejects unsupported, binary, and invalid JSON Artifacts", () => {
    const state = createFixtureState();
    const task = createTask(state);
    const json = createTaskArtifact(
      state,
      task.id,
      {
        type: "json",
        name: "Metrics",
        content: JSON.stringify({ confidence: 0.9 })
      },
      "user"
    );

    expect(() =>
      createTaskArtifact(
        state,
        task.id,
        {
          type: "binary",
          name: "Binary",
          content: "AAECAw=="
        },
        "user"
      )
    ).toThrow("Invalid option");
    expect(() =>
      createTaskArtifact(
        state,
        task.id,
        {
          type: "text",
          name: "Binary body",
          content: { bytes: [0, 1, 2, 3] }
        },
        "user"
      )
    ).toThrow("Invalid input");
    expect(() =>
      updateTaskArtifact(
        state,
        task.id,
        json.id,
        { content: "{" },
        "user"
      )
    ).toThrow("JSON Artifact content is invalid");
    expect(state.artifacts).toHaveLength(1);
  });
});
