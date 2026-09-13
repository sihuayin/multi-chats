import type { DiscussionBrief } from "@/server/application/discussion-brief";

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function mapDiscussionBriefToTask(input: {
  brief: DiscussionBrief;
  discussionTitle: string;
  selectedOptionId?: string;
  taskTitle?: string;
  taskGoal?: string;
  assigneeIds: string[];
}): {
  title: string;
  goal: string;
  assigneeIds: string[];
  selectedOptionId: string;
} {
  const selectedOptionId =
    input.selectedOptionId ?? input.brief.recommendation.optionId;
  const option = input.brief.options.find(
    (item) => item.id === selectedOptionId
  );
  if (!option) {
    throw new Error("Selected Brief option was not found");
  }

  const goal =
    input.taskGoal ??
    [
      option.summary,
      `Recommendation: ${input.brief.recommendation.rationale}`,
      option.risks.length > 0
        ? `Risks: ${option.risks.join("; ")}`
        : "",
      input.brief.openQuestions.length > 0
        ? `Open questions: ${input.brief.openQuestions.join("; ")}`
        : "",
      `Brief ${input.brief.discussionId}`
    ]
      .filter(Boolean)
      .join("\n\n");

  return {
    title: input.taskTitle ?? `${input.discussionTitle}: ${option.title}`,
    goal,
    assigneeIds: unique(input.assigneeIds),
    selectedOptionId
  };
}
