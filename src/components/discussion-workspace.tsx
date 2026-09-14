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
import { cn } from "@/lib/utils";
import styles from "./discussion-workspace.module.css";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

function statusVariant(status: string) {
  if (["failed", "cancelled", "interrupted"].includes(status)) {
    return "destructive" as const;
  }
  if (["completed", "review"].includes(status)) {
    return "secondary" as const;
  }
  return "outline" as const;
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
    <div className={`${styles.shell} discussion-workspace-shell`}>
      <aside className={styles.rail}>
        <div className={styles.railHeader}>
          <span>Conversation center</span>
          <strong>Discussions</strong>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="discussion-conversation">Conversation</Label>
          <Select
            value={conversation?.id ?? ""}
            onValueChange={(next) => {
              setSelectedConversationId(next);
              setSelectedDiscussionId("");
              setLoadedView(null);
              setRoleByEmployee({});
              setSelectedParticipantIds([]);
              setFacilitatorId("");
            }}
          >
            <SelectTrigger
              id="discussion-conversation"
              aria-label="Discussion conversation"
            >
              <SelectValue placeholder="Choose conversation" />
            </SelectTrigger>
            <SelectContent>
              {conversations.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Separator />
        <ScrollArea className="min-h-0 flex-1">
          <div className={styles.discussionList}>
            {discussions.map((discussion) => (
              <Button
                key={discussion.id}
                variant={
                  discussion.id === selectedDiscussionId
                    ? "secondary"
                    : "ghost"
                }
                className="h-auto justify-start px-3 py-2.5"
                onClick={() => setSelectedDiscussionId(discussion.id)}
              >
                <span className="grid min-w-0 flex-1 gap-0.5 text-left">
                  <strong className="truncate text-xs">
                    {discussion.title}
                  </strong>
                  <small className="text-[10px] text-[var(--muted-foreground)]">
                    {discussion.status}
                  </small>
                </span>
                <ChevronRight className="opacity-50" />
              </Button>
            ))}
            {discussions.length === 0 ? (
              <p className="px-2 text-xs text-[var(--muted-foreground)]">
                No Discussion in this Conversation.
              </p>
            ) : null}
          </div>
        </ScrollArea>
      </aside>

      <main className={styles.center}>
        {!view ? (
          <Card className="mx-auto mt-[5vh] w-full max-w-4xl">
            <CardHeader>
              <div className="text-[var(--accent)] font-mono text-[10px] font-bold uppercase tracking-[0.08em]">
                New bounded Discussion
              </div>
              <CardTitle className="font-serif text-3xl">
                Frame the decision before the team speaks.
              </CardTitle>
              <CardDescription>
                Define the topic, participants, roles, and round budget.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="grid gap-2 md:col-span-2">
                  <Label htmlFor="discussion-topic">Topic</Label>
                  <Input
                    id="discussion-topic"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="What should the team analyze?"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Mode</Label>
                  <Select
                    value={mode}
                    onValueChange={(value) =>
                      setMode(value as DiscussionMode)
                    }
                  >
                    <SelectTrigger aria-label="Mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {modes.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Language</Label>
                  <Select
                    value={language}
                    onValueChange={(value) =>
                      setLanguage(value as "en" | "zh")
                    }
                  >
                    <SelectTrigger aria-label="Discussion language">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="zh">中文</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="discussion-rounds">Content rounds</Label>
                  <Input
                    id="discussion-rounds"
                    type="number"
                    min={1}
                    max={5}
                    value={maxRounds}
                    onChange={(event) =>
                      setMaxRounds(Number(event.target.value))
                    }
                  />
                </div>
              </div>
              <Separator />
              <div className="grid gap-3">
                <Label>Participants</Label>
                <div className="grid gap-2 md:grid-cols-2">
                  {(conversation?.memberIds ?? []).map((employeeId) => {
                    const employee = data?.employees.find(
                      (item) => item.id === employeeId
                    );
                    const selected =
                      selectedParticipantIds.length === 0 ||
                      selectedParticipantIds.includes(employeeId);
                    return (
                      <div
                        key={employeeId}
                        className="flex items-center gap-3 rounded-md border bg-[var(--paper)] p-3"
                      >
                        <Checkbox
                          aria-label={`Include ${employee?.name ?? employeeId}`}
                          checked={selected}
                          disabled={
                            selected &&
                            (selectedParticipantIds.length > 0
                              ? selectedParticipantIds.length
                              : conversation.memberIds.length) <= 2
                          }
                          onCheckedChange={() =>
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
                        <strong className="min-w-0 flex-1 truncate text-sm">
                          {employee?.name ?? employeeId}
                        </strong>
                        <Select
                          value={
                            effectiveRoleByEmployee[employeeId] ?? "analyst"
                          }
                          onValueChange={(role) =>
                            setRoleByEmployee((current) => ({
                              ...current,
                              [employeeId]: role as DiscussionRole
                            }))
                          }
                        >
                          <SelectTrigger
                            aria-label={`${employee?.name ?? employeeId} role`}
                            className="w-[130px]"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {roles.map((role) => (
                              <SelectItem key={role} value={role}>
                                {titleCase(role)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="grid gap-2 md:max-w-sm">
                <Label>Facilitator</Label>
                <Select
                  value={effectiveFacilitatorId}
                  onValueChange={setFacilitatorId}
                >
                  <SelectTrigger aria-label="Facilitator">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(effectiveRoleByEmployee).map((employeeId) => (
                      <SelectItem key={employeeId} value={employeeId}>
                        {data?.employees.find(
                          (item) => item.id === employeeId
                        )?.name ?? employeeId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end">
                <Button
                  onClick={() => void createDiscussion()}
                  disabled={busy || !conversation || !title.trim()}
                >
                  {busy ? (
                    <LoaderCircle className="spin" />
                  ) : (
                    <Plus />
                  )}
                  Create Discussion
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
            <header className={styles.header}>
              <div>
                <div className="flex items-center gap-2">
                  <span className={styles.eyebrow}>
                    {titleCase(view.discussion.mode)}
                  </span>
                  <Badge variant={statusVariant(view.discussion.status)}>
                    {view.discussion.status}
                  </Badge>
                </div>
                <h1>{view.discussion.title}</h1>
                <p>
                  Round {view.discussion.currentRound} /{" "}
                  {view.discussion.maxRounds} ·{" "}
                  {view.discussion.participantCount} participants
                </p>
              </div>
              <div className={styles.commandRow}>
                {view.availableActions.includes("start") ? (
                  <Button size="sm" onClick={() => void runCommand("start")}>
                    <Play /> Start
                  </Button>
                ) : null}
                {view.availableActions.includes("stop") ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void runCommand("stop")}
                  >
                    <CircleStop /> Stop
                  </Button>
                ) : null}
                {view.availableActions.includes("retry") ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void runCommand("retry")}
                  >
                    <RefreshCw /> Resume
                  </Button>
                ) : null}
                {view.availableActions.includes("extend") ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void runCommand("extend")}
                  >
                    <Sparkles /> Extend
                  </Button>
                ) : null}
                {view.availableActions.includes("cancel") ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void runCommand("cancel")}
                  >
                    <X /> Cancel
                  </Button>
                ) : null}
              </div>
            </header>

            <div className={styles.workbench}>
              <Card className={cn(styles.participants, "gap-3 py-4")}>
                <CardHeader className="px-4">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <UsersRound /> Participants
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-1 px-3">
                  {view.participants.map((participant) => (
                    <div
                      key={participant.id}
                      className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 rounded-md p-2 hover:bg-[var(--accent)]"
                    >
                      <Avatar>
                        <AvatarFallback>
                          {participant.name.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="grid min-w-0 gap-1">
                        <div className="flex items-center justify-between gap-2">
                          <strong className="truncate text-xs">
                            {participant.name}
                          </strong>
                          <Badge variant="outline" className="text-[10px]">
                            {titleCase(participant.role)}
                          </Badge>
                        </div>
                        <p className="line-clamp-3 text-[11px] text-[var(--muted-foreground)]">
                          {participant.objective}
                        </p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card className={cn(styles.stage, "gap-0 overflow-hidden py-0")}>
                <Tabs
                  value={effectiveRoundId}
                  onValueChange={setSelectedRoundId}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <div className="overflow-x-auto border-b p-3">
                    <TabsList className="h-auto min-w-max bg-transparent p-0">
                      {view.rounds.map((round) => (
                        <TabsTrigger
                          key={round.id}
                          value={round.id}
                          className="min-w-[130px] flex-none flex-col items-start gap-0.5 px-3 py-2"
                        >
                          <span className="text-[10px] font-mono text-[var(--accent)]">
                            R{round.roundNumber}
                          </span>
                          <span>{titleCase(round.phase)}</span>
                          <small className="text-[10px] text-[var(--muted-foreground)]">
                            {round.status}
                          </small>
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </div>
                  <TabsContent
                    value={effectiveRoundId}
                    className="m-0 min-h-0 flex-1"
                  >
                    <ScrollArea className="h-full">
                      <div className="grid gap-4 p-5">
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
                            <Card
                              key={turn.id}
                              className="gap-3 py-4 shadow-none"
                            >
                              <CardHeader className="flex-row items-center justify-between px-4">
                                <CardTitle className="text-sm">
                                  {employee?.name ?? turn.employeeId}
                                </CardTitle>
                                <div className="flex items-center gap-2">
                                  <Badge variant="outline">
                                    {titleCase(turn.role)}
                                  </Badge>
                                  <Badge variant={statusVariant(turn.status)}>
                                    {turn.status}
                                  </Badge>
                                </div>
                              </CardHeader>
                              <CardContent className="px-4">
                                <p className="text-sm leading-6 text-[var(--ink)]">
                                  {summary}
                                </p>
                              </CardContent>
                            </Card>
                          );
                        })}
                        {!currentRoundDetail ||
                        currentRoundDetail.turns.length === 0 ? (
                          <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
                            <ChevronRight />
                            This phase has not produced a Turn yet.
                          </div>
                        ) : null}
                      </div>
                    </ScrollArea>
                  </TabsContent>
                </Tabs>
                {view.availableActions.includes("synthesize") ? (
                  <div className="border-t p-3">
                    <Button
                      variant="secondary"
                      onClick={() => void runCommand("synthesize")}
                    >
                      <Sparkles /> Synthesize available Turns
                    </Button>
                  </div>
                ) : null}
              </Card>

              <Card className={cn(styles.brief, "gap-4 py-5")}>
                <CardHeader className="px-5">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <FileJson /> Brief
                  </CardTitle>
                  {view.latestBrief ? (
                    <CardDescription>
                      Revision {view.latestBrief.revision}
                    </CardDescription>
                  ) : null}
                </CardHeader>
                <CardContent className="grid gap-3 px-5">
                  {selectedBrief ? (
                    <>
                      {selectedBrief.options.map((option) => {
                        const selected =
                          (selectedOptionId ||
                            selectedBrief.recommendation.optionId) ===
                          option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            className={cn(
                              "grid gap-1 rounded-md border p-3 text-left transition-colors",
                              selected
                                ? "border-[var(--primary)] bg-[var(--accent)]"
                                : "hover:bg-[var(--muted)]"
                            )}
                            onClick={() => setSelectedOptionId(option.id)}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <strong className="text-xs">
                                {option.title}
                              </strong>
                              {selected ? (
                                <Check className="text-[var(--primary)]" />
                              ) : null}
                            </div>
                            <p className="text-[11px] leading-5 text-[var(--muted-foreground)]">
                              {option.summary}
                            </p>
                          </button>
                        );
                      })}
                      <Separator />
                      <Input
                        value={taskTitle}
                        onChange={(event) => setTaskTitle(event.target.value)}
                        placeholder="Task title override"
                      />
                      <Button
                        onClick={() => void confirmBrief()}
                        disabled={busy}
                      >
                        <Check /> Confirm and create Task
                      </Button>
                    </>
                  ) : (
                    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
                      <FileJson />
                      The first Brief appears after Synthesis.
                    </div>
                  )}
                  {view.confirmedTask ? (
                    <div className="grid gap-1 rounded-md bg-[var(--success-soft)] p-3 text-[var(--success)]">
                      <span className="text-[10px] uppercase">Task created</span>
                      <strong className="text-sm">
                        {view.confirmedTask.title}
                      </strong>
                      <small>{view.confirmedTask.status}</small>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </div>
            {view.activeRun ? (
              <div className="sticky bottom-4 ml-auto mt-4 flex w-fit items-center gap-2 rounded-full border bg-[var(--background)] px-3 py-2 text-xs shadow-lg">
                <LoaderCircle className="spin" />
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
