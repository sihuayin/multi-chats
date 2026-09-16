"use client";

import { useState } from "react";
import { MessagesSquare, PanelsTopLeft } from "lucide-react";
import { ChatWorkspace } from "@/components/chat-workspace";
import { DiscussionWorkspace } from "@/components/discussion-workspace";
import styles from "./conversation-center.module.css";

export function ConversationCenter({
  initialView = "chat",
  conversationId,
  taskId,
  discussionId
}: {
  initialView?: "chat" | "discussion";
  conversationId?: string;
  taskId?: string;
  discussionId?: string;
}) {
  const [view, setView] = useState<"chat" | "discussion">(initialView);

  return (
    <div className={`${styles.shell} conversation-center`}>
      <div className={styles.switch} role="tablist" aria-label="Conversation view">
        <button
          role="tab"
          id="chat-tab"
          aria-controls="chat-panel"
          aria-selected={view === "chat"}
          tabIndex={view === "chat" ? 0 : -1}
          className={view === "chat" ? styles.active : ""}
          onClick={() => setView("chat")}
        >
          <MessagesSquare size={15} />
          Chat
        </button>
        <button
          role="tab"
          id="discussion-tab"
          aria-controls="discussion-panel"
          aria-selected={view === "discussion"}
          tabIndex={view === "discussion" ? 0 : -1}
          className={view === "discussion" ? styles.active : ""}
          onClick={() => setView("discussion")}
        >
          <PanelsTopLeft size={15} />
          Discussion
        </button>
      </div>
      <div
        id="chat-panel"
        role="tabpanel"
        aria-labelledby="chat-tab"
        hidden={view !== "chat"}
      >
        <ChatWorkspace
          initialConversationId={conversationId}
          initialTaskId={taskId}
        />
      </div>
      <div
        id="discussion-panel"
        role="tabpanel"
        aria-labelledby="discussion-tab"
        hidden={view !== "discussion"}
      >
        {view === "discussion" ? (
          <DiscussionWorkspace
            initialConversationId={conversationId}
            initialDiscussionId={discussionId}
          />
        ) : null}
      </div>
    </div>
  );
}
