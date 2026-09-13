"use client";

import {
  useEffect,
  useMemo,
  useState
} from "react";
import {
  Check,
  ChevronRight,
  CircleStop,
  FileJson,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  UsersRound,
  X
} from "lucide-react";
import { apiRequest } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-provider";
import styles from "./discussion-workspace.module.css";
import type {
  DiscussionMode,
  DiscussionRole
} from "@/server/domain/types";

type DiscussionAction =
  | "edit"
  | "start"
  | "stop"
  | "retry"
  | "skip"
  | "add_constraints"
  | "synthesize"
  | "extend"
  | "confirm"
  | "cancel";

type DiscussionView = {
  discussion: {
    id: string;
    conversationId: string;
    title: string;
    mode: DiscussionMode;
    language: "en" | "zh";
    status: string;
    facilitatorId: string;
    participantCount: number;
    currentRound: number;
    maxRounds: number;
    latestBriefRevision?: number;
    confirmedTaskId?: string;
  };
  participants: Array<{
    id: string;
    employeeId: string;
    name: string;
    role: DiscussionRole;
    objective: string;
    order: number;
    active: boolean;
  }>;
  rounds: Array<{
    id: string;
    roundNumber: number;
    phase: "positions" | "cross_response" | "synthesis";
    status: string;
    runId?: string;
    turnCount: number;
    completedTurnCount: number;
  }>;
  latestBrief?: {
    artifactId: string;
    revision: number;
    content: string;
  };
  confirmedTask?: {
    id: string;
    title: string;
    status: string;
  };
  activeRun?: { id: string; status: string };
  budget: {
    usedRounds: number;
    maxRounds: number;
    usedParticipants: number;
  };
  availableActions: DiscussionAction[];
};

type RoundDetail = {
  id: string;
  phase: string;
  status: string;
  turns: Array<{
    id: string;
    employeeId: string;
    role: DiscussionRole;
    status: string;
    content?: string;
    payload?: { summary?: string; claims?: Array<{ statement: string }> };
  }>;
};

const modes: Array<{ id: DiscussionMode; label: string }> = [
  { id: "requirements", label: "Requirements" },
  { id: "problem", label: "Problem" },
  { id: "solution", label: "Solution" },
  { id: "review", label: "Review" }
];

const roles: DiscussionRole[] = [
  "analyst",
  "researcher",
  "skeptic",
  "designer",
  "facilitator"
];

function titleCase(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function DiscussionWorkspace() {
  const { data, refresh } = useWorkspace();
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedDiscussionId, setSelectedDiscussionId] = useState("");
  const [loadedView, setLoadedView] = useState<DiscussionView | null>(null);
  const [roundDetail, setRoundDetail] = useState<RoundDetail | null>(null);
  const [selectedRoundId, setSelectedRoundId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<DiscussionMode>("problem");
  const [language, setLanguage] = useState<"en" | "zh">("en");
  const [maxRounds, setMaxRounds] = useState(3);
  const [roleByEmployee, setRoleByEmployee] = useState<
    Record<string, DiscussionRole>
  >({});
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);
  const [facilitatorId, setFacilitatorId] = useState("");
  const [selectedOptionId, setSelectedOptionId] = useState("");
  const [taskTitle, setTaskTitle] = useState("");

  const conversations = data?.conversations ?? [];
  const conversation =
    conversations.find((item) => item.id === selectedConversationId) ??
    conversations[0];
  const view =
    selectedDiscussionId &&
    loadedView?.discussion.id === selectedDiscussionId
      ? loadedView
      : null;
  const discussions = useMemo(
    () =>
      (data?.discussions ?? []).filter(
        (discussion) =>
          !conversation || discussion.conversationId === conversation.id
      ),
    [data?.discussions, conversation]
  );

  useEffect(() => {
    if (!selectedDiscussionId) return;
    let cancelled = false;
    void apiRequest<DiscussionView>(
      `/api/discussions/${selectedDiscussionId}`
    )
      .then((next) => {
        if (!cancelled) {
          setLoadedView(next);
          setSelectedOptionId((current) => current || "");
        }
      })
      .catch((nextError) => {
        if (!cancelled) setError(String(nextError));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDiscussionId, data]);

  const activeRunId = view?.activeRun?.id;
  const discussionId = view?.discussion.id;
  const effectiveRoundId =
    view?.rounds.some((round) => round.id === selectedRoundId)
      ? selectedRoundId
      : view?.rounds.at(-1)?.id ?? "";

  useEffect(() => {
    if (!discussionId) return;
    const sources: EventSource[] = [];
    const discussionSource = new EventSource(
      `/api/discussions/${discussionId}/events?afterSequence=0`
    );
    discussionSource.onmessage = () => void refresh();
    discussionSource.onerror = () => discussionSource.close();
    sources.push(discussionSource);
    if (activeRunId) {
      const runSource = new EventSource(
        `/api/runs/${activeRunId}/events?after=0`
      );
      runSource.onmessage = () => void refresh();
      runSource.onerror = () => runSource.close();
      sources.push(runSource);
    }
    const poll = setInterval(() => void refresh(), 1_000);
    return () => {
      clearInterval(poll);
      sources.forEach((source) => source.close());
    };
  }, [activeRunId, discussionId, refresh]);

  useEffect(() => {
    if (!view || view.rounds.length === 0) return;
    void apiRequest<RoundDetail>(
      `/api/discussions/${view.discussion.id}/rounds/${effectiveRoundId}`
    ).then(setRoundDetail).catch((nextError) => setError(String(nextError)));
  }, [effectiveRoundId, view]);

  const selectedBrief = (() => {
    if (!view?.latestBrief) return null;
    try {
      return JSON.parse(view.latestBrief.content) as {
        title: string;
        recommendation: { optionId: string };
        options: Array<{
          id: string;
          title: string;
          summary: string;
          risks: string[];
        }>;
      };
    } catch {
      return null;
    }
  })();

  const effectiveRoleByEmployee =
    Object.fromEntries(
      (selectedParticipantIds.length > 0
        ? selectedParticipantIds
        : conversation?.memberIds ?? []
      ).map((employeeId, index) => [
        employeeId,
        roleByEmployee[employeeId] ??
          (index ===
          (selectedParticipantIds.length > 0
            ? selectedParticipantIds.length
            : conversation?.memberIds.length ?? 1) -
            1
            ? "facilitator"
            : "analyst")
      ])
    );
  const effectiveFacilitatorId =
    (facilitatorId &&
    Object.prototype.hasOwnProperty.call(
      effectiveRoleByEmployee,
      facilitatorId
    )
      ? facilitatorId
      : undefined) ||
    Object.keys(effectiveRoleByEmployee).at(-1) ||
    "";
  if (effectiveFacilitatorId) {
    for (const employeeId of Object.keys(effectiveRoleByEmployee)) {
      if (employeeId === effectiveFacilitatorId) {
        effectiveRoleByEmployee[employeeId] = "facilitator";
      } else if (effectiveRoleByEmployee[employeeId] === "facilitator") {
        effectiveRoleByEmployee[employeeId] = "analyst";
      }
    }
  }
  const currentRoundDetail =
    roundDetail?.id === effectiveRoundId ? roundDetail : null;

  async function runCommand(
    command: string,
    body: Record<string, unknown> = {}
  ) {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const next = await apiRequest<DiscussionView>(
        `/api/discussions/${view.discussion.id}/${command}`,
        { method: "POST", body: JSON.stringify(body) }
      );
      setLoadedView(next);
      await refresh();
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function createDiscussion() {
    if (!conversation || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await apiRequest<DiscussionView>(
        `/api/conversations/${conversation.id}/discussions`,
        {
          method: "POST",
          body: JSON.stringify({
            title,
            mode,
            language,
            maxRounds,
            participants: Object.keys(effectiveRoleByEmployee).map(
              (employeeId) => ({
                employeeId,
                role: effectiveRoleByEmployee[employeeId] ?? "analyst"
              })
            ),
            facilitatorId: effectiveFacilitatorId
          })
        }
      );
      setLoadedView(created);
      setSelectedDiscussionId(created.discussion.id);
      setTitle("");
      await refresh();
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function confirmBrief() {
    if (!selectedBrief) return;
    setBusy(true);
    setError(null);
    try {
      const next = await apiRequest<DiscussionView>(
        `/api/discussions/${view!.discussion.id}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({
            selectedOptionId:
              selectedOptionId || selectedBrief.recommendation.optionId,
            taskTitle: taskTitle || undefined
          })
        }
      );
      setLoadedView(next);
      await refresh();
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.rail}>
        <div className={styles.railHeader}>
          <span>Conversation center</span>
          <strong>Discussions</strong>
        </div>
        <label className={styles.field}>
          <span>Conversation</span>
          <select
            aria-label="Discussion conversation"
            value={conversation?.id ?? ""}
            onChange={(event) => {
              setSelectedConversationId(event.target.value);
              setSelectedDiscussionId("");
              setLoadedView(null);
              setRoleByEmployee({});
              setSelectedParticipantIds([]);
              setFacilitatorId("");
            }}
          >
            {conversations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.discussionList}>
          {discussions.map((discussion) => (
            <button
              key={discussion.id}
              className={
                discussion.id === selectedDiscussionId ? styles.selected : ""
              }
              onClick={() => setSelectedDiscussionId(discussion.id)}
            >
              <span>{discussion.title}</span>
              <small>{discussion.status}</small>
            </button>
          ))}
          {discussions.length === 0 ? (
            <p>No Discussion in this Conversation.</p>
          ) : null}
        </div>
      </aside>

      <main className={styles.center}>
        {!view ? (
          <section className={styles.setup}>
            <div className={styles.eyebrow}>New bounded Discussion</div>
            <h1>Frame the decision before the team speaks.</h1>
            <div className={styles.setupGrid}>
              <label className={styles.field}>
                <span>Topic</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="What should the team analyze?"
                />
              </label>
              <label className={styles.field}>
                <span>Mode</span>
                <select
                  value={mode}
                  onChange={(event) =>
                    setMode(event.target.value as DiscussionMode)
                  }
                >
                  {modes.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span>Language</span>
                <select
                  aria-label="Discussion language"
                  value={language}
                  onChange={(event) =>
                    setLanguage(event.target.value as "en" | "zh")
                  }
                >
                  <option value="en">English</option>
                  <option value="zh">中文</option>
                </select>
              </label>
              <label className={styles.field}>
                <span>Content rounds</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={maxRounds}
                  onChange={(event) => setMaxRounds(Number(event.target.value))}
                />
              </label>
            </div>
            <div className={styles.participantConfig}>
              {(conversation?.memberIds ?? []).map((employeeId) => {
                const employee = data?.employees.find(
                  (item) => item.id === employeeId
                );
                const selected =
                  selectedParticipantIds.length === 0 ||
                  selectedParticipantIds.includes(employeeId);
                return (
                  <div key={employeeId}>
                    <input
                      type="checkbox"
                      aria-label={`Include ${employee?.name ?? employeeId}`}
                      checked={selected}
                      disabled={
                        selected &&
                        (selectedParticipantIds.length > 0
                          ? selectedParticipantIds.length
                          : conversation.memberIds.length) <= 2
                      }
                      onChange={() =>
                        setSelectedParticipantIds((current) => {
                          const base =
                            current.length > 0
                              ? current
                              : conversation.memberIds;
                          return selected
                            ? base.filter((id) => id !== employeeId)
                            : [...base, employeeId];
                        })
                      }
                    />
                    <strong>{employee?.name ?? employeeId}</strong>
                    <select
                      aria-label={`${employee?.name ?? employeeId} role`}
              value={effectiveRoleByEmployee[employeeId] ?? "analyst"}
                      onChange={(event) =>
                        setRoleByEmployee((current) => ({
                          ...current,
                          [employeeId]: event.target.value as DiscussionRole
                        }))
                      }
                    >
                      {roles.map((role) => (
                        <option key={role} value={role}>
                          {titleCase(role)}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <label className={styles.field}>
              <span>Facilitator</span>
              <select
                value={effectiveFacilitatorId}
                onChange={(event) => setFacilitatorId(event.target.value)}
              >
                {Object.keys(effectiveRoleByEmployee).map((employeeId) => (
                  <option key={employeeId} value={employeeId}>
                    {data?.employees.find((item) => item.id === employeeId)
                      ?.name ?? employeeId}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={styles.primary}
              onClick={() => void createDiscussion()}
              disabled={busy || !conversation || !title.trim()}
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
              Create Discussion
            </button>
          </section>
        ) : (
          <>
            <header className={styles.header}>
              <div>
                <span className={styles.eyebrow}>
                  {titleCase(view.discussion.mode)} ·{" "}
                  {view.discussion.status}
                </span>
                <h1>{view.discussion.title}</h1>
                <p>
                  Round {view.discussion.currentRound} /{" "}
                  {view.discussion.maxRounds} ·{" "}
                  {view.discussion.participantCount} participants
                </p>
              </div>
              <div className={styles.commandRow}>
                {view.availableActions.includes("start") ? (
                  <button onClick={() => void runCommand("start")}>
                    <Play size={15} /> Start
                  </button>
                ) : null}
                {view.availableActions.includes("stop") ? (
                  <button onClick={() => void runCommand("stop")}>
                    <CircleStop size={15} /> Stop
                  </button>
                ) : null}
                {view.availableActions.includes("retry") ? (
                  <button onClick={() => void runCommand("retry")}>
                    <RefreshCw size={15} /> Resume
                  </button>
                ) : null}
                {view.availableActions.includes("extend") ? (
                  <button onClick={() => void runCommand("extend")}>
                    <Sparkles size={15} /> Extend
                  </button>
                ) : null}
                {view.availableActions.includes("cancel") ? (
                  <button
                    className={styles.danger}
                    onClick={() => void runCommand("cancel")}
                  >
                    <X size={15} /> Cancel
                  </button>
                ) : null}
              </div>
            </header>

            <div className={styles.workbench}>
              <aside className={styles.participants}>
                <div className={styles.sectionLabel}>
                  <UsersRound size={14} /> Participants
                </div>
                {view.participants.map((participant) => (
                  <article key={participant.id}>
                    <span>{participant.name.slice(0, 2).toUpperCase()}</span>
                    <div>
                      <strong>{participant.name}</strong>
                      <small>{titleCase(participant.role)}</small>
                      <p>{participant.objective}</p>
                    </div>
                  </article>
                ))}
              </aside>

              <section className={styles.stage}>
                <div className={styles.tabs}>
                  {view.rounds.map((round) => (
                    <button
                      key={round.id}
                      className={
                        round.id === effectiveRoundId ? styles.activeTab : ""
                      }
                      onClick={() => setSelectedRoundId(round.id)}
                    >
                      <span>R{round.roundNumber}</span>
                      {titleCase(round.phase)}
                      <small>{round.status}</small>
                    </button>
                  ))}
                </div>
                <div className={styles.stageBody}>
                  {currentRoundDetail?.turns.map((turn) => {
                    const employee = view.participants.find(
                      (participant) =>
                        participant.employeeId === turn.employeeId
                    );
                    const summary =
                      turn.payload?.summary ??
                      turn.payload?.claims?.[0]?.statement ??
                      turn.content ??
                      "Waiting for response.";
                    return (
                      <article key={turn.id}>
                        <div>
                          <strong>{employee?.name ?? turn.employeeId}</strong>
                          <span>{titleCase(turn.role)}</span>
                          <small>{turn.status}</small>
                        </div>
                        <p>{summary}</p>
                      </article>
                    );
                  })}
                  {!currentRoundDetail ||
                  currentRoundDetail.turns.length === 0 ? (
                    <div className={styles.empty}>
                      <ChevronRight size={18} />
                      This phase has not produced a Turn yet.
                    </div>
                  ) : null}
                </div>
                {view.availableActions.includes("synthesize") ? (
                  <button
                    className={styles.secondary}
                    onClick={() => void runCommand("synthesize")}
                  >
                    <Sparkles size={15} /> Synthesize available Turns
                  </button>
                ) : null}
              </section>

              <aside className={styles.brief}>
                <div className={styles.sectionLabel}>
                  <FileJson size={14} /> Brief
                </div>
                {selectedBrief ? (
                  <>
                    <div className={styles.briefMeta}>
                      Revision {view.latestBrief?.revision}
                    </div>
                    {selectedBrief.options.map((option) => (
                      <label key={option.id} className={styles.option}>
                        <input
                          type="radio"
                          name="brief-option"
                          checked={
                            (selectedOptionId ||
                              selectedBrief.recommendation.optionId) ===
                            option.id
                          }
                          onChange={() => setSelectedOptionId(option.id)}
                        />
                        <span>
                          <strong>{option.title}</strong>
                          <p>{option.summary}</p>
                        </span>
                      </label>
                    ))}
                    <input
                      value={taskTitle}
                      onChange={(event) => setTaskTitle(event.target.value)}
                      placeholder="Task title override"
                    />
                    <button
                      className={styles.primary}
                      onClick={() => void confirmBrief()}
                      disabled={busy}
                    >
                      <Check size={15} /> Confirm and create Task
                    </button>
                  </>
                ) : (
                  <div className={styles.empty}>
                    <FileJson size={18} />
                    The first Brief appears after Synthesis.
                  </div>
                )}
                {view.confirmedTask ? (
                  <div className={styles.taskHandoff}>
                    <span>Task created</span>
                    <strong>{view.confirmedTask.title}</strong>
                    <small>{view.confirmedTask.status}</small>
                  </div>
                ) : null}
              </aside>
            </div>
            {view.activeRun ? (
              <div className={styles.runStrip}>
                <LoaderCircle className="spin" size={14} />
                Active Run {view.activeRun.status}
              </div>
            ) : null}
          </>
        )}
        {error ? <div className={styles.error}>{error}</div> : null}
      </main>
    </div>
  );
}
