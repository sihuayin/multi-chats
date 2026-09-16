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
  PanelRightClose,
  PanelRightOpen,
  Play,
  RotateCcw,
  Send,
  ShieldAlert,
  Trash2,
  UserPen,
  UsersRound,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { apiRequest } from "@/lib/api";
import { toast } from "sonner";
import { useI18n } from "@/components/i18n-provider";
import type {
  ApprovalDecision,
  Artifact,
  Conversation,
  Task
} from "@/server/domain/types";
import { useWorkspace } from "@/components/workspace-provider";
import type { TranslationKey } from "@/lib/i18n";
import { artifactTypes } from "@/lib/artifact-types";
import {
  buildRunTimeline,
  eventAssociations,
  eventSummary,
  type RunTimelineCategory
} from "@/lib/run-timeline";
import { employeeTurnStatuses } from "@/lib/employee-turn-status";
import {
  activeMention,
  filterMentionEmployees,
  mentionSlug
} from "@/lib/mentions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

function MessageIcon({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "json") return <FileJson size={16} />;
  return <FileText size={16} />;
}

function ArtifactContent({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "markdown") {
    return (
      <div className="artifact-markdown">
        <ReactMarkdown>{artifact.content}</ReactMarkdown>
      </div>
    );
  }

  if (artifact.type === "json") {
    let content = artifact.content;
    try {
      content = JSON.stringify(JSON.parse(artifact.content), null, 2);
    } catch {
      // Invalid legacy data remains inspectable instead of breaking the Task panel.
    }
    return <pre className="artifact-json">{content}</pre>;
  }

  return <pre className="artifact-text">{artifact.content}</pre>;
}

function statusKey(status: string): TranslationKey {
  return `status.${status}` as TranslationKey;
}

function artifactTypeKey(type: Artifact["type"]): TranslationKey {
  return `artifact.${type}`;
}

function timelineCategoryKey(category: RunTimelineCategory): TranslationKey {
  return `timeline.${category}`;
}

function ApprovalActions({
  onResolve
}: {
  onResolve: (decision: ApprovalDecision) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="button-row wrap">
      <button
        className="button primary"
        onClick={() => onResolve("approved")}
      >
        <Check size={16} />
        {t("chat.approve")}
      </button>
      <button
        className="button danger"
        onClick={() => onResolve("rejected")}
      >
        <X size={16} />
        {t("chat.reject")}
      </button>
      <button
        className="button quiet"
        onClick={() => onResolve("cancelled")}
      >
        <Ban size={16} />
        {t("chat.cancelApproval")}
      </button>
    </div>
  );
}

export function ChatWorkspace({
  initialConversationId,
  initialTaskId
}: {
  initialConversationId?: string;
  initialTaskId?: string;
} = {}) {
  const { data, refresh } = useWorkspace();
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConversationId ?? null
  );
  const [message, setMessage] = useState("");
  const [groupChoice, setGroupChoice] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [taskAssigneeIds, setTaskAssigneeIds] = useState<string[]>([]);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [taskPanelOpen, setTaskPanelOpen] = useState(true);
  const [conversationToDelete, setConversationToDelete] =
    useState<Conversation | null>(null);
  const [mentionState, setMentionState] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [membersDialogOpen, setMembersDialogOpen] = useState(false);
  const [draftMemberIds, setDraftMemberIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const focusedTaskRef = useRef<string | null>(null);

  const conversations = useMemo(
    () => data?.conversations ?? [],
    [data?.conversations]
  );
  const selected =
    conversations.find((conversation) => conversation.id === selectedId) ??
    conversations[0] ??
    null;
  const selectedTaskAssigneeIds = useMemo(
    () =>
      taskAssigneeIds.filter((assigneeId) =>
        selected?.memberIds.includes(assigneeId)
      ),
    [selected?.memberIds, taskAssigneeIds]
  );

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

  useEffect(() => {
    if (
      !initialTaskId ||
      focusedTaskRef.current === initialTaskId ||
      !tasks.some((task) => task.id === initialTaskId)
    ) {
      return;
    }
    focusedTaskRef.current = initialTaskId;
    window.requestAnimationFrame(() => {
      document
        .getElementById(`task-${initialTaskId}`)
        ?.scrollIntoView({ block: "center" });
    });
  }, [initialTaskId, tasks]);

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
  const latestRunTimeline = useMemo(
    () => buildRunTimeline(latestRunEvents),
    [latestRunEvents]
  );
  const employeeTurnStates = useMemo(
    () =>
      latestRun
        ? employeeTurnStatuses(latestRun, latestRunEvents)
        : new Map(),
    [latestRun, latestRunEvents]
  );
  const displayMemberIds = useMemo(() => {
    if (!selected) return [];
    if (
      latestRun &&
      ["queued", "running", "waiting_approval"].includes(latestRun.status)
    ) {
      return [
        ...latestRun.memberSnapshot,
        ...selected.memberIds.filter(
          (memberId) => !latestRun.memberSnapshot.includes(memberId)
        )
      ];
    }
    return selected.memberIds;
  }, [latestRun, selected]);

  const mentionCandidates = useMemo(() => {
    if (!selected || !mentionState) return [];
    const employees = selected.memberIds
      .map((memberId) =>
        data?.employees.find((employee) => employee.id === memberId)
      )
      .filter(
        (employee): employee is NonNullable<typeof employee> =>
          Boolean(employee?.active)
      );
    const filtered = filterMentionEmployees(employees, mentionState.query);
    const all = {
      id: "all",
      name: t("chat.members"),
      slug: "all"
    };
    const matchesAll =
      mentionState.query.length === 0 ||
      "all".includes(mentionState.query.toLowerCase());
    return [
      ...(matchesAll ? [all] : []),
      ...filtered.map((employee) => ({
        id: employee.id,
        name: employee.name,
        slug: mentionSlug(employee.name)
      }))
    ];
  }, [data?.employees, mentionState, selected, t]);

  function messageArtifacts(messageId: string): Artifact[] {
    const artifactIds = new Set(
      (data?.runEvents ?? [])
        .filter(
          (event) =>
            event.type === "artifact_created" &&
            event.payload.messageId === messageId
        )
        .map((event) => String(event.payload.artifactId ?? ""))
        .filter(Boolean)
    );
    return (data?.artifacts ?? []).filter((artifact) =>
      artifactIds.has(artifact.id)
    );
  }

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
      setMentionState(null);
      await refresh();
      if (result.run) setStartedRunId(result.run.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  function updateMention(value: string, caret: number) {
    setMentionState(activeMention(value, caret));
    setMentionIndex(0);
  }

  function chooseMention(candidate: {
    id: string;
    name: string;
    slug: string;
  }) {
    if (!mentionState) return;
    const before = message.slice(0, mentionState.start);
    const after = message.slice(
      mentionState.end
    );
    const inserted = `@${candidate.slug} `;
    const next = `${before}${inserted}${after}`;
    const caret = before.length + inserted.length;
    setMessage(next);
    setMentionState(null);
    requestAnimationFrame(() => {
      const textarea = composerRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
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

  async function resolveApproval(
    id: string,
    decision: ApprovalDecision
  ) {
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
          assigneeIds:
            selectedTaskAssigneeIds.length > 0
              ? selectedTaskAssigneeIds
              : selected.memberIds
        })
      });
      setTaskTitle("");
      setTaskGoal("");
      setTaskAssigneeIds([]);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function runTaskCommand(
    task: Task,
    command: "run" | "stop" | "resume" | "cancel"
  ) {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/tasks/${task.id}/${command}`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() }
      });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function editMembers() {
    if (!selected) return;
    setDraftMemberIds(selected.memberIds);
    setMembersDialogOpen(true);
  }

  async function saveMembers() {
    if (!selected) return;
    setBusy(true);
    try {
      await apiRequest(`/api/conversations/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ memberIds: draftMemberIds })
      });
      setMembersDialogOpen(false);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function deleteConversation() {
    if (!conversationToDelete) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/conversations/${conversationToDelete.id}`, {
        method: "DELETE"
      });
      if (selected?.id === conversationToDelete.id) setSelectedId(null);
      setConversationToDelete(null);
      toast.success(t("chat.deleted"));
      await refresh();
    } catch (nextError) {
      const message =
        nextError instanceof Error ? nextError.message : String(nextError);
      if (message.includes("Conversation was not found")) {
        if (selected?.id === conversationToDelete.id) setSelectedId(null);
        setConversationToDelete(null);
        toast.success(t("chat.deleted"));
        await refresh();
        return;
      }
      setError(message);
      toast.error(message);
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

  async function updateArtifact(artifact: Artifact) {
    const name = window.prompt(t("chat.artifactName"), artifact.name);
    if (!name?.trim()) return;
    const content = window.prompt(t("chat.artifactContent"), artifact.content);
    if (content === null) return;
    setBusy(true);
    try {
      await apiRequest(
        `/api/tasks/${artifact.ownerId}/artifacts/${artifact.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name, content })
        }
      );
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
            <div
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
              <span className="conversation-copy">
                <strong>{conversation.title}</strong>
                <small>
                  {conversation.memberIds.length} {t("chat.members")}
                </small>
              </span>
              <button
                className="conversation-delete"
                title={t("chat.deleteConversation")}
                onClick={(event) => {
                  event.stopPropagation();
                  setConversationToDelete(conversation);
                }}
                disabled={busy}
              >
                <Trash2 size={14} />
              </button>
            </div>
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
                {displayMemberIds.map((memberId) => {
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
                      {employeeTurnStates.has(memberId) ? (
                        <span
                          className={`member-turn-state ${employeeTurnStates.get(
                            memberId
                          )}`}
                        >
                          {t(
                            `turn.${employeeTurnStates.get(memberId)}` as TranslationKey
                          )}
                        </span>
                      ) : null}
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
                className="icon-button task-panel-toggle"
                title={
                  taskPanelOpen
                    ? t("chat.collapseTasks")
                    : t("chat.expandTasks")
                }
                aria-label={
                  taskPanelOpen
                    ? t("chat.collapseTasks")
                    : t("chat.expandTasks")
                }
                aria-controls="task-panel"
                aria-expanded={taskPanelOpen}
                onClick={() => setTaskPanelOpen((open) => !open)}
              >
                {taskPanelOpen ? (
                  <PanelRightClose size={16} />
                ) : (
                  <PanelRightOpen size={16} />
                )}
              </button>
            </header>

            <div className="message-stream">
              {latestRun?.status === "failed" && latestRun.error ? (
                <div className="error-banner compact">
                  {latestRun.error}
                </div>
              ) : null}
              {messages.map((item) => {
                const artifacts = messageArtifacts(item.id);
                return (
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
                    <p>
                      {item.content || (item.status === "streaming" ? "..." : "")}
                    </p>
                    {artifacts.length > 0 ? (
                      <div className="artifact-list message-artifacts">
                        {artifacts.map((artifact) => (
                          <details key={artifact.id}>
                            <summary>
                              <MessageIcon artifact={artifact} />
                              {artifact.name}
                              <span>{t(artifactTypeKey(artifact.type))}</span>
                            </summary>
                            <ArtifactContent artifact={artifact} />
                          </details>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
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
                  <ApprovalActions
                    onResolve={(decision) =>
                      void resolveApproval(approval.id, decision)
                    }
                  />
                </article>
              ))}
            </div>

            <div className="composer">
              {mentionState && mentionCandidates.length > 0 ? (
                <div
                  id="mention-options"
                  className="mention-menu"
                  role="listbox"
                >
                  {mentionCandidates.map((candidate, index) => (
                    <button
                      key={candidate.id}
                      type="button"
                      role="option"
                      aria-selected={index === mentionIndex}
                      className={
                        index === mentionIndex ? "mention-option active" : "mention-option"
                      }
                      onMouseDown={(event) => {
                        event.preventDefault();
                        chooseMention(candidate);
                      }}
                    >
                      <span className="mention-mark">
                        {candidate.id === "all"
                          ? "@"
                          : candidate.name.slice(0, 2).toUpperCase()}
                      </span>
                      <span>
                        <strong>{candidate.name}</strong>
                        <small>@{candidate.slug}</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                ref={composerRef}
                value={message}
                aria-autocomplete="list"
                aria-controls={
                  mentionState && mentionCandidates.length > 0
                    ? "mention-options"
                    : undefined
                }
                onChange={(event) => {
                  const next = event.target.value;
                  setMessage(next);
                  updateMention(
                    next,
                    event.target.selectionStart ?? next.length
                  );
                }}
                onClick={(event) =>
                  updateMention(
                    event.currentTarget.value,
                    event.currentTarget.selectionStart ??
                      event.currentTarget.value.length
                  )
                }
                onKeyUp={(event) => {
                  if (
                    !["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(
                      event.key
                    )
                  ) {
                    updateMention(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart ??
                        event.currentTarget.value.length
                    );
                  }
                }}
                placeholder={t("chat.messagePlaceholder")}
                onKeyDown={(event) => {
                  if (
                    mentionState &&
                    mentionCandidates.length > 0
                  ) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setMentionIndex(
                        (index) =>
                          (index + 1) % mentionCandidates.length
                      );
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setMentionIndex(
                        (index) =>
                          (index - 1 + mentionCandidates.length) %
                          mentionCandidates.length
                      );
                      return;
                    }
                    if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      chooseMention(
                        mentionCandidates[
                          Math.min(
                            mentionIndex,
                            mentionCandidates.length - 1
                          )
                        ]
                      );
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setMentionState(null);
                      return;
                    }
                  }
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

      <aside id="task-panel" className="task-panel">
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
            <fieldset className="choice-fieldset compact">
              <legend>{t("chat.assignees")}</legend>
              {selected.memberIds.map((memberId) => {
                const employee = data?.employees.find(
                  (item) => item.id === memberId
                );
                return (
                  <label key={memberId} className="check-row">
                    <input
                      type="checkbox"
                      checked={selectedTaskAssigneeIds.includes(memberId)}
                      onChange={(event) =>
                        setTaskAssigneeIds((current) =>
                          event.target.checked
                            ? [...current, memberId]
                            : current.filter((id) => id !== memberId)
                        )
                      }
                    />
                    <span>{employee?.name ?? t("common.unknown")}</span>
                  </label>
                );
              })}
            </fieldset>
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
            <ApprovalActions
              onResolve={(decision) =>
                void resolveApproval(approval.id, decision)
              }
            />
          </article>
        ))}
        <div className="task-list">
          {tasks.map((task) => {
            const pendingApproval = pendingApprovals.find(
              (approval) => approval.taskId === task.id
            );
            const displayedStatus = pendingApproval
              ? "waiting_approval"
              : task.status;
            const artifacts = (data?.artifacts ?? []).filter(
              (artifact) =>
                artifact.ownerType === "task" && artifact.ownerId === task.id
            );
            return (
              <article
                key={task.id}
                id={`task-${task.id}`}
                className="task-card"
              >
                <div className="task-card-header">
                  <strong>{task.title}</strong>
                  <span className={`status-pill ${displayedStatus}`}>
                    {t(statusKey(displayedStatus))}
                  </span>
                </div>
                <p>{task.goal}</p>
                <small>
                  {task.assigneeIds
                    .map(
                      (assigneeId) =>
                        data?.employees.find(
                          (employee) => employee.id === assigneeId
                        )?.name ?? t("common.unknown")
                    )
                    .join(", ")}
                </small>
                <div className="button-row wrap">
                  {task.availableActions.includes("start") ? (
                    <button
                      className="button quiet"
                      onClick={() => runTaskCommand(task, "run")}
                      disabled={busy}
                    >
                      <Play size={14} />
                      {task.status === "draft"
                        ? t("chat.start")
                        : t("chat.startAgain")}
                    </button>
                  ) : null}
                  {task.availableActions.includes("stop") ? (
                    <button
                      className="button quiet"
                      onClick={() => runTaskCommand(task, "stop")}
                      disabled={busy}
                    >
                      <CircleStop size={14} />
                      {t("chat.stop")}
                    </button>
                  ) : null}
                  {task.availableActions.includes("resume_run") ? (
                    <button
                      className="button quiet"
                      onClick={() => runTaskCommand(task, "resume")}
                      disabled={busy}
                    >
                      <RotateCcw size={14} />
                      {t("chat.resumeRun")}
                    </button>
                  ) : null}
                  {task.status === "draft" &&
                  !task.availableActions.includes("start") ? (
                    <span className="field-hint">
                      {t("chat.startUnavailable")}
                    </span>
                  ) : null}
                  {task.availableActions.includes("block") &&
                  task.availableActions.includes("review") ? (
                    <>
                      <button
                        className="button quiet"
                        onClick={() => updateTask(task, "blocked")}
                      >
                        {t("chat.block")}
                      </button>
                      <button
                        className="button quiet"
                        onClick={() => updateTask(task, "review")}
                      >
                        {t("chat.review")}
                      </button>
                    </>
                  ) : null}
                  {task.availableActions.includes("resume") &&
                  task.availableActions.includes("review") ? (
                    <>
                      <button
                        className="button quiet"
                        onClick={() => updateTask(task, "in_progress")}
                      >
                        {t("chat.resume")}
                      </button>
                      <button
                        className="button quiet"
                        onClick={() => updateTask(task, "review")}
                      >
                        {t("chat.review")}
                      </button>
                    </>
                  ) : null}
                  {task.availableActions.includes("return_to_work") &&
                  task.availableActions.includes("complete") ? (
                    <>
                      <button
                        className="button quiet"
                        onClick={() => updateTask(task, "in_progress")}
                      >
                        {t("chat.returnToWork")}
                      </button>
                      <button
                        className="button quiet"
                        onClick={() => updateTask(task, "completed")}
                      >
                        <Check size={14} />
                        {t("chat.complete")}
                      </button>
                    </>
                  ) : null}
                  {task.availableActions.includes("cancel") ? (
                    <button
                      className="button quiet danger-text"
                      onClick={() => runTaskCommand(task, "cancel")}
                      disabled={busy}
                    >
                      <Ban size={14} />
                      {t("chat.cancel")}
                    </button>
                  ) : null}
                  <select
                    className="artifact-type-select"
                    aria-label={t("chat.artifactType")}
                    defaultValue=""
                    onChange={(event) => {
                      const type = event.target.value as Artifact["type"];
                      event.target.value = "";
                      if (type) void attachArtifact(task, type);
                    }}
                  >
                    <option value="" disabled>
                      {t("chat.artifact")}
                    </option>
                    {artifactTypes.map((type) => (
                      <option key={type} value={type}>
                        {t(artifactTypeKey(type))}
                      </option>
                    ))}
                  </select>
                </div>
                {artifacts.length > 0 ? (
                  <div className="artifact-list">
                    {artifacts.map((artifact) => (
                      <details key={artifact.id}>
                        <summary>
                          <MessageIcon artifact={artifact} />
                          {artifact.name}
                          <span>
                            {t(artifactTypeKey(artifact.type))}
                            {artifact.runId
                              ? ` · Run ${artifact.runId.slice(0, 8)}`
                              : ""}
                          </span>
                        </summary>
                        <ArtifactContent artifact={artifact} />
                        <div className="artifact-actions">
                          <button
                            className="button quiet"
                            onClick={() => void updateArtifact(artifact)}
                          >
                            {t("common.edit")}
                          </button>
                        </div>
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
                {latestRunTimeline.map((entry) => {
                  if (entry.kind === "message") {
                    const employee = data?.employees.find(
                      (item) => item.id === entry.employeeId
                    );
                    return (
                      <li
                        key={`message-${entry.fromSequence}`}
                        className="timeline-entry message"
                        data-category="model"
                        data-association={`message:${entry.messageId}`}
                      >
                        <div className="timeline-entry-heading">
                          <strong>
                            {employee?.name ?? t("chat.employee")} ·{" "}
                            {t("timeline.model")}
                          </strong>
                          <time>
                            {new Date(entry.createdAt).toLocaleTimeString()}
                          </time>
                        </div>
                        <p>{entry.content}</p>
                        <small>
                          {t("timeline.message")} {entry.messageId.slice(0, 8)}
                        </small>
                      </li>
                    );
                  }

                  const associations = eventAssociations(entry.event);
                  const summary = eventSummary(entry.event);
                  return (
                    <li
                      key={entry.event.id}
                      className={`timeline-entry ${entry.category}`}
                      data-category={entry.category}
                    >
                      <div className="timeline-entry-heading">
                        <strong>
                          {t(timelineCategoryKey(entry.category))} ·{" "}
                          <code>{entry.event.type.replaceAll("_", " ")}</code>
                        </strong>
                        <time>
                          {new Date(entry.event.createdAt).toLocaleTimeString()}
                        </time>
                      </div>
                      {summary ? <p>{summary}</p> : null}
                      {associations.length > 0 ? (
                        <div className="timeline-associations">
                          {associations.map((association) => (
                            <span
                              key={`${association.type}:${association.id}`}
                            >
                              {association.type === "message"
                                ? t("timeline.message")
                                : t("chat.tasks")}{" "}
                              {association.id.slice(0, 8)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </details>
          ) : null}
        </div>
      </aside>
      <Dialog open={membersDialogOpen} onOpenChange={setMembersDialogOpen}>
        <DialogContent className="h-[min(640px,88dvh)] grid-rows-[auto_auto_minmax(0,1fr)_auto]">
          <DialogHeader>
            <DialogTitle>{t("chat.editMembers")}</DialogTitle>
            <DialogDescription>
              {t("chat.editMembersHint")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-24 min-h-12 flex-wrap content-start gap-1.5 overflow-y-auto rounded-md border bg-[var(--paper)] p-2">
            {draftMemberIds.map((memberId) => {
              const employee = data?.employees.find(
                (item) => item.id === memberId
              );
              return (
                <Badge key={memberId} variant="secondary">
                  {employee?.name ?? memberId}
                  <button
                    type="button"
                    aria-label={`${t("common.remove")} ${employee?.name ?? memberId}`}
                    className="ml-1 rounded-sm opacity-60 hover:opacity-100"
                    onClick={() =>
                      setDraftMemberIds((current) =>
                        current.filter((id) => id !== memberId)
                      )
                    }
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              );
            })}
            {draftMemberIds.length === 0 ? (
              <span className="text-xs text-[var(--muted-foreground)]">
                {t("chat.noMembers")}
              </span>
            ) : null}
          </div>
          <Command className="min-h-0 rounded-md border">
            <CommandInput placeholder={t("chat.memberSearch")} />
            <CommandList className="max-h-none min-h-0 flex-1">
              <CommandEmpty className="flex min-h-40 items-center justify-center">
                {t("chat.noMemberResults")}
              </CommandEmpty>
              <CommandGroup>
                {(data?.employees ?? [])
                  .filter((employee) => employee.active)
                  .map((employee) => {
                    const selected = draftMemberIds.includes(employee.id);
                    return (
                      <CommandItem
                        key={employee.id}
                        value={`${employee.name} ${employee.identity}`}
                        onSelect={() =>
                          setDraftMemberIds((current) =>
                            selected
                              ? current.filter((id) => id !== employee.id)
                              : [...current, employee.id]
                          )
                        }
                      >
                        <Check
                          className={
                            selected ? "opacity-100" : "opacity-0"
                          }
                        />
                        <span className="grid min-w-0 flex-1">
                          <strong className="truncate">
                            {employee.name}
                          </strong>
                          <small className="truncate text-[11px] text-[var(--muted-foreground)]">
                            {employee.identity}
                          </small>
                        </span>
                      </CommandItem>
                    );
                  })}
              </CommandGroup>
            </CommandList>
          </Command>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMembersDialogOpen(false)}
              disabled={busy}
            >
              {t("chat.cancel")}
            </Button>
            <Button onClick={() => void saveMembers()} disabled={busy}>
              {busy ? <LoaderCircle className="spin" /> : <Check />}
              {t("chat.saveMembers")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={conversationToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConversationToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat.deleteConversation")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat.deleteConversationConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("chat.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-[var(--danger)] text-white hover:bg-[var(--danger)]"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void deleteConversation();
              }}
            >
              {busy ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Trash2 size={15} />
              )}
              {t("chat.deleteConversation")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
