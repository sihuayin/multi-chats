import { ConversationCenter } from "@/components/conversation-center";

type HomeSearchParams = {
  view?: string | string[];
  conversation?: string | string[];
  task?: string | string[];
  discussion?: string | string[];
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function HomePage({
  searchParams
}: {
  searchParams: Promise<HomeSearchParams>;
}) {
  const params = await searchParams;
  return (
    <ConversationCenter
      initialView={first(params.view) === "discussion" ? "discussion" : "chat"}
      conversationId={first(params.conversation)}
      taskId={first(params.task)}
      discussionId={first(params.discussion)}
    />
  );
}
