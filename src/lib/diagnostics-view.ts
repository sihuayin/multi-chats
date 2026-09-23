export type DiagnosticsHealth =
  | "healthy"
  | "stale"
  | "degraded"
  | "unavailable"
  | "unknown";

export type DiagnosticsCommandKind =
  | "cancel"
  | "stop"
  | "resume"
  | "retry";

export type DiagnosticsCommand = {
  kind: DiagnosticsCommandKind;
  method: "DELETE" | "POST";
  href: string;
};

export type DiagnosticsFailureKind =
  | "retryable"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "malformed_output"
  | "ambiguous"
  | "terminal"
  | "unknown";

export type DiagnosticsRun = {
  id: string;
  status: string;
  conversationId: string;
  conversationTitle: string;
  href: string;
  taskId?: string;
  taskTitle?: string;
  discussionId?: string;
  discussionTitle?: string;
  errorCode?: string;
  pendingApprovalCount: number;
  actions: DiagnosticsCommand[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type DiagnosticsProvider = {
  id: string;
  label: string;
  provider: string;
  status: DiagnosticsHealth;
  validationStatus: "validated" | "unknown";
  lastValidatedAt?: string;
  lastAttemptAt?: string;
  recentAttemptCount: number;
  lastErrorKind?: string;
  lastErrorCode?: string;
};

export type DiagnosticsFailure = {
  latestAttemptId: string;
  provider: string;
  modelId: string;
  count: number;
  attemptIds: string[];
  runIds: string[];
  statuses: string[];
  failureKinds: DiagnosticsFailureKind[];
  usedFallback: boolean;
  errorKinds: string[];
  errorCodes: string[];
  runId?: string;
  conversationId?: string;
  taskId?: string;
  discussionId?: string;
  href?: string;
  lastOccurredAt: string;
};

export type DiagnosticsDiscussion = {
  id: string;
  conversationId: string;
  title: string;
  mode: string;
  status: string;
  currentRound: number;
  maxRounds: number;
  reason?: string;
  href: string;
  actions: DiagnosticsCommand[];
  pendingInterventionCount: number;
  tokenBudgetState: string;
  costBudgetState: string;
  tokensUsed: number;
  costUsedMicros: number;
  currency?: string;
};

/**
 * Two numbers and nothing else: the size of the searchable corpus and what
 * recent searches cost in time. Deliberately no recall or quality figure —
 * that needs an evaluation, not a page — and no alerts: nobody receives
 * alerts from this view.
 */
export type DiagnosticsRetrieval = {
  /** Chunks a search would consider: current chunks of ready, non-deleted Sources. */
  searchableChunkCount: number;
  /** search_sources completions in the whole ledger. */
  recentSearchCount: number;
  /** Duration of the most recent searches, newest first, capped. */
  recentSearchDurationsMs: number[];
};

export type DiagnosticsView = {
  generatedAt: string;
  worker: {
    status: DiagnosticsHealth;
    heartbeatAt?: string;
    ageMs?: number;
  };
  providers: DiagnosticsProvider[];
  runs: {
    queued: DiagnosticsRun[];
    active: DiagnosticsRun[];
    recoverable: DiagnosticsRun[];
  };
  discussions: DiagnosticsDiscussion[];
  usage: {
    windowHours: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostMicros: number | null;
    currency?: string;
    unknownUsageAttempts: number;
    unknownPricingAttempts: number;
    retryAttempts: number;
    fallbackAttempts: number;
  };
  failures: DiagnosticsFailure[];
  retrieval: DiagnosticsRetrieval;
};
