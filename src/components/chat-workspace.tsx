"use client";

import {
  Ban,
  Check,
  CircleStop,
  Clock3,
  FileJson,
  FileText,
  Hash,
  LoaderCircle,
  MessageSquarePlus,
  PanelRight,
  RotateCcw,
  Send,
  ShieldAlert,
  UserPen,
  UsersRound,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";
import type {
  Artifact,
  Conversation,
  Task
} from "@/server/domain/types";
import { useWorkspace } from "@/components/workspace-provider";
import type { TranslationKey } from "@/lib/i18n";

function MessageIcon({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "json") return <FileJson size={16} />;
  return <FileText size={16} />;
}

function statusKey(status: string): TranslationKey {
  return `status.${status}` as TranslationKey;
}

export function ChatWorkspace() {
  const { data, refresh } = useWorkspace();
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [groupChoice, setGroupChoice] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [taskPanelOpen, setTaskPanelOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const conversations = useMemo(
    () => data?.conversations ?? [],
    [data?.conversations]
  );
  const selected =
    conversations.find((conversation) => conversation.id === selectedId) ??
    conversations[0] ??
    null;

  const activeRun = useMemo(
    () =>
      (data?.runs ?? []).find(
      (run) =>
        run.conversationId === selected?.id &&
        ["queued", "running", "waiting_approval"].includes(run.status)
      ),
    [data?.runs, selected?.id]
  );
  const activeRunId = activeRun?.id ?? startedRunId;

  useEffect(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (!activeRunId) return;

    const source = new EventSource(`/api/runs/${activeRunId}/events`);
    eventSourceRef.current = source;
    source.onmessage = () => {
      void refresh();
    };
    source.onerror = () => {
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
    };

    return () => source.close();
  }, [activeRunId, refresh]);

  const messages = useMemo(
    () =>
      (data?.messages ?? []).filter(
        (item) => item.conversationId === selected?.id
      ),
    [data?.messages, selected?.id]
  );
  const tasks = useMemo(
    () =>
      (data?.tasks ?? []).filter((task) => task.conversationId === selected?.id),
    [data?.tasks, selected?.id]
  );
  const conversationRuns = useMemo(
    () => (data?.runs ?? []).filter((run) => run.conversationId === selected?.id),
    [data?.runs, selected?.id]
  );
  const pendingApprovals = useMemo(
    () =>
      (data?.approvals ?? []).filter(
        (approval) =>
          approval.status === "pending" &&
          conversationRuns.some((run) => run.id === approval.runId)
      ),
    [conversationRuns, data?.approvals]
  );
  const latestRun = conversationRuns.at(-1);
  const latestRunEvents = useMemo(
    () =>
      latestRun
        ? (data?.runEvents ?? [])
            .filter((event) => event.runId === latestRun.id)
            .sort((left, right) => left.sequence - right.sequence)
        : [],
    [data?.runEvents, latestRun]
  );

  async function createConversation() {
    const group =
      groupChoice === "ad-hoc"
        ? undefined
        : data?.groups.find((item) => item.id === groupChoice) ??
          data?.groups.at(-1);
    const title = group
      ? `${group.name} ${t("chat.conversation")}`
      : t("chat.adHocConversation");
    setBusy(true);
    try {
      const conversation = await apiRequest<Conversation>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({
          title,
          groupId: group?.id,
          memberIds: group ? [] : data?.employees.filter((e) => e.active).map((e) => e.id)
        })
      });
      setSelectedId(conversation.id);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage() {
    if (!selected || !message.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest<{ run: { id: string } | null }>(
        `/api/conversations/${selected.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ content: message })
        }
      );
      setMessage("");
      await refresh();
      if (result.run) setStartedRunId(result.run.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun() {
    if (!activeRunId) return;
    setBusy(true);
    try {
      await apiRequest(`/api/runs/${activeRunId}`, { method: "DELETE" });
      setStartedRunId(null);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function resumeRun() {
    if (!latestRun) return;
    setBusy(true);
    try {
      await apiRequest(`/api/runs/${latestRun.id}/resume`, { method: "POST" });
      setStartedRunId(latestRun.id);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function resolveApproval(id: string, decision: "approved" | "rejected") {
    setBusy(true);
    try {
      await apiRequest(`/api/approvals/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ decision })
      });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function createTask() {
    if (!selected || !taskTitle.trim() || !taskGoal.trim()) return;
    setBusy(true);
    try {
      await apiRequest(`/api/conversations/${selected.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title: taskTitle,
          goal: taskGoal,
          assigneeIds: selected.memberIds
        })
      });
      setTaskTitle("");
      setTaskGoal("");
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function editMembers() {
    if (!selected) return;
    const current = selected.memberIds
      .map(
        (memberId) =>
          data?.employees.find((employee) => employee.id === memberId)?.name ?? ""
      )
      .filter(Boolean);
    const next = window.prompt(
      t("chat.editMembersPrompt"),
      current.join(", ")
    );
    if (next === null) return;
    setBusy(true);
    try {
      const memberIds = next
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
          const employee = data?.employees.find(
            (item) => item.name.toLowerCase() === value.toLowerCase()
          );
          if (!employee) {
            throw new Error(`${t("common.unknown")}: ${value}`);
          }
          return employee.id;
        });
      await apiRequest(`/api/conversations/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ memberIds })
      });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function updateTask(task: Task, status: Task["status"]) {
    setBusy(true);
    try {
      await apiRequest(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function attachArtifact(task: Task, type: Artifact["type"]) {
    const name = window.prompt(t("chat.artifactName"));
    if (!name) return;
    const content = window.prompt(t("chat.artifactContent"));
    if (content === null) return;
    setBusy(true);
    try {
      await apiRequest(`/api/tasks/${task.id}/artifacts`, {
        method: "POST",
        body: JSON.stringify({ name, content, type })
      });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={taskPanelOpen ? "workspace-grid" : "workspace-grid tasks-collapsed"}>
      <section className="conversation-rail">
        <div className="section-heading">
          <div>
            <span className="eyebrow">{t("common.workspace")}</span>
            <h1>{t("chat.conversations")}</h1>
          </div>
          <button
            className="icon-button"
            onClick={createConversation}
            title={t("chat.newConversation")}
            disabled={busy}
          >
            <MessageSquarePlus size={18} />
          </button>
        </div>
        <div className="conversation-list">
          <select
            className="rail-select"
            aria-label={t("chat.conversation")}
            value={groupChoice}
            onChange={(event) => setGroupChoice(event.target.value)}
          >
            <option value="">{t("chat.latestGroup")}</option>
            <option value="ad-hoc">{t("chat.adHoc")}</option>
            {data?.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={
                conversation.id === selected?.id
                  ? "conversation-item active"
                  : "conversation-item"
              }
              onClick={() => setSelectedId(conversation.id)}
            >
              <span className="conversation-icon">
                <Hash size={15} />
              </span>
              <span>
                <strong>{conversation.title}</strong>
                <small>
                  {conversation.memberIds.length} {t("chat.members")}
                </small>
              </span>
            </button>
          ))}
          {conversations.length === 0 ? (
            <div className="rail-empty">
              <UsersRound size={20} />
              <span>{t("chat.noConversations")}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="conversation-surface">
        {error ? <div className="error-banner">{error}</div> : null}
        {selected ? (
          <>
            <header className="conversation-header">
              <div>
                <span className="eyebrow">{t("chat.conversation")}</span>
                <h2>{selected.title}</h2>
              </div>
              <div className="member-stack" aria-label={t("chat.editMembers")}>
                {selected.memberIds.map((memberId) => {
                  const employee = data?.employees.find(
                    (item) => item.id === memberId
                  );
                  return (
                    <span key={memberId} className="member-chip">
                      <i
                        className={
                          employee?.active
                            ? "member-state active"
                            : "member-state"
                        }
                        title={
                          employee?.active
                            ? t("common.active")
                            : t("common.disabled")
                        }
                      />
                      {employee?.name ?? t("common.unknown")}
                    </span>
                  );
                })}
              </div>
              {activeRunId ? (
                <button className="button secondary" onClick={cancelRun}>
                  <CircleStop size={16} />
                  {t("chat.stop")}
                </button>
              ) : null}
              {latestRun?.status === "interrupted" ? (
                <button className="button secondary" onClick={resumeRun}>
                  <RotateCcw size={16} />
                  {t("chat.resume")}
                </button>
              ) : null}
              <button
                className="icon-button"
                title={t("chat.editMembers")}
                onClick={editMembers}
                disabled={busy}
              >
                <UserPen size={16} />
              </button>
              <button
                className="icon-button"
                title={t("chat.toggleTasks")}
                onClick={() => setTaskPanelOpen((open) => !open)}
              >
                <PanelRight size={16} />
              </button>
            </header>

            <div className="message-stream">
              {messages.map((item) => (
                <article
                  key={item.id}
                  className={`message-bubble ${item.authorType}`}
                  data-status={item.status}
                >
                  <div className="message-meta">
                    <strong>
                      {item.authorType === "user"
                        ? t("chat.you")
                        : data?.employees.find(
                            (employee) => employee.id === item.authorId
                          )?.name ?? t("chat.employee")}
                    </strong>
                    <time>{new Date(item.createdAt).toLocaleTimeString()}</time>
                    {item.status === "streaming" ? (
                      <LoaderCircle className="spin" size={13} />
                    ) : null}
                  </div>
                  <p>{item.content || (item.status === "streaming" ? "..." : "")}</p>
                </article>
              ))}
              {messages.length === 0 ? (
                <div className="empty-state compact">
                  <MessageSquarePlus size={22} />
                  <span>{t("chat.mentionPrompt")}</span>
                </div>
              ) : null}

              {pendingApprovals.map((approval) => (
                <article key={approval.id} className="approval-card">
                  <div className="approval-title">
                    <ShieldAlert size={17} />
                    <strong>
                      {t("chat.approvalRequired", { tool: approval.toolName })}
                    </strong>
                  </div>
                  <pre>{JSON.stringify(approval.args, null, 2)}</pre>
                  <div className="button-row">
                    <button
                      className="button primary"
                      onClick={() => resolveApproval(approval.id, "approved")}
                    >
                      <Check size={16} />
                      {t("chat.approve")}
                    </button>
                    <button
                      className="button danger"
                      onClick={() => resolveApproval(approval.id, "rejected")}
                    >
                      <X size={16} />
                      {t("chat.reject")}
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <div className="composer">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={t("chat.messagePlaceholder")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
              />
              <button
                className="button primary"
                onClick={sendMessage}
                disabled={busy || !message.trim()}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                {t("chat.send")}
              </button>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <Hash size={24} />
            <strong>{t("chat.createConversation")}</strong>
            <span>{t("chat.createConversationHint")}</span>
          </div>
        )}
      </section>

      <aside className="task-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">{t("common.accountability")}</span>
            <h2>{t("chat.tasks")}</h2>
          </div>
        </div>
        {selected ? (
          <div className="compact-form">
            <input
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
              placeholder={t("chat.taskTitle")}
            />
            <textarea
              value={taskGoal}
              onChange={(event) => setTaskGoal(event.target.value)}
              placeholder={t("chat.taskGoal")}
            />
            <button
              className="button secondary"
              onClick={createTask}
              disabled={busy || !taskTitle.trim() || !taskGoal.trim()}
            >
              {t("chat.addTask")}
            </button>
          </div>
        ) : null}
        {pendingApprovals.map((approval) => (
          <article key={approval.id} className="approval-card task-approval">
            <div className="approval-title">
              <ShieldAlert size={16} />
              <strong>{approval.toolName}</strong>
            </div>
            <div className="button-row">
              <button
                className="button primary"
                onClick={() => resolveApproval(approval.id, "approved")}
              >
                {t("chat.approve")}
              </button>
              <button
                className="button danger"
                onClick={() => resolveApproval(approval.id, "rejected")}
              >
                {t("chat.reject")}
              </button>
            </div>
          </article>
        ))}
        <div className="task-list">
          {tasks.map((task) => {
            const artifacts = (data?.artifacts ?? []).filter(
              (artifact) => artifact.taskId === task.id
            );
            return (
              <article key={task.id} className="task-card">
                <div className="task-card-header">
                  <strong>{task.title}</strong>
                  <span className={`status-pill ${task.status}`}>
                    {t(statusKey(task.status))}
                  </span>
                </div>
                <p>{task.goal}</p>
                <div className="button-row wrap">
                  {task.status === "draft" ? (
                    <button
                      className="button quiet"
                      onClick={() => updateTask(task, "in_progress")}
                    >
                      {t("chat.start")}
                    </button>
                  ) : null}
                  {task.status === "in_progress" ? (
                    <button
                      className="button quiet"
                      onClick={() => updateTask(task, "review")}
                    >
                      {t("chat.review")}
                    </button>
                  ) : null}
                  {task.status === "review" ? (
                    <button
                      className="button quiet"
                      onClick={() => updateTask(task, "completed")}
                    >
                      <Check size={14} />
                      {t("chat.complete")}
                    </button>
                  ) : null}
                  {["draft", "in_progress", "blocked", "review"].includes(
                    task.status
                  ) ? (
                    <button
                      className="button quiet danger-text"
                      onClick={() => updateTask(task, "cancelled")}
                    >
                      <Ban size={14} />
                      {t("chat.cancel")}
                    </button>
                  ) : null}
                  <button
                    className="button quiet"
                    onClick={() => attachArtifact(task, "markdown")}
                  >
                    <FileText size={14} />
                    {t("chat.artifact")}
                  </button>
                </div>
                {artifacts.length > 0 ? (
                  <div className="artifact-list">
                    {artifacts.map((artifact) => (
                      <details key={artifact.id}>
                        <summary>
                          <MessageIcon artifact={artifact} />
                          {artifact.name}
                          <span>{artifact.type}</span>
                        </summary>
                        <pre>{artifact.content}</pre>
                      </details>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
          {tasks.length === 0 ? (
            <div className="empty-state compact">
              <FileText size={20} />
              <span>{t("chat.noTasks")}</span>
            </div>
          ) : null}
          {latestRun ? (
            <details
              className="run-timeline"
              data-run-status={latestRun.status}
            >
              <summary>
                <Clock3 size={15} />
                {t("chat.runTimeline")}
                <span>{t(statusKey(latestRun.status))}</span>
              </summary>
              <ol>
                {latestRunEvents.map((event) => (
                  <li key={event.id}>
                    <strong>{event.type.replaceAll("_", " ")}</strong>
                    <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
