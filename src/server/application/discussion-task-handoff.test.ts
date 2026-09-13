import { describe, expect, it } from "vitest";
import { mapDiscussionBriefToTask } from "@/server/application/discussion-task-handoff";
import { createFixtureBrief } from "@/server/test-support/fixtures";

describe("Discussion Brief Task handoff", () => {
  it("selects the recommendation by default", () => {
    const brief = createFixtureBrief("discussion-1");
    const task = mapDiscussionBriefToTask({
      brief,
      discussionTitle: "Choose a persistence model",
      assigneeIds: ["employee-2", "employee-1"]
    });

    expect(task).toMatchObject({
      title: "Choose a persistence model: Keep the state document",
      assigneeIds: ["employee-2", "employee-1"],
      selectedOptionId: "state-document"
    });
    expect(task.goal).toContain(
      "Continue using the shared JSON aggregate."
    );
    expect(task.goal).toContain(
      "It has the smallest migration surface."
    );
    expect(task.goal).toContain("Brief discussion-1");
  });

  it("supports an alternate option and Task overrides", () => {
    const brief = createFixtureBrief("discussion-1");
    brief.options.push({
      id: "relational",
      title: "Normalize the state",
      summary: "Use relational tables.",
      benefits: ["Strong queries"],
      costs: ["More migrations"],
      risks: ["More schema work"]
    });

    const task = mapDiscussionBriefToTask({
      brief,
      discussionTitle: "Choose a persistence model",
      selectedOptionId: "relational",
      taskTitle: "Implement relational persistence",
      taskGoal: "Normalize the aggregate.",
      assigneeIds: ["employee-3"]
    });

    expect(task).toMatchObject({
      title: "Implement relational persistence",
      goal: "Normalize the aggregate.",
      assigneeIds: ["employee-3"],
      selectedOptionId: "relational"
    });
  });

  it("rejects an option that is not in the Brief revision", () => {
    expect(() =>
      mapDiscussionBriefToTask({
        brief: createFixtureBrief("discussion-1"),
        discussionTitle: "Choose",
        selectedOptionId: "missing",
        assigneeIds: ["employee-1"]
      })
    ).toThrow("Selected Brief option was not found");
  });
});
