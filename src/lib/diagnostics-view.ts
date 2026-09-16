export type DiagnosticsHealth =
  | "healthy"
  | "stale"
  | "degraded"
  | "unavailable"
  | "unknown";

export type DiagnosticsRun = {
  id: string;
  status: string;
  conversationId: string;
  conversationTitle: string;
  taskId?: string;
  taskTitle?: string;
  discussionId?: string;
  discussionTitle?: string;
  errorCode?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type DiagnosticsProvider = {
  id: string;
  label: string;
  provider: string;
  status: DiagnosticsHealth;
  lastValidatedAt?: string;
  lastAttemptAt?: string;
  recentAttemptCount: number;
  lastErrorKind?: string;
  lastErrorCode?: string;
};

export type DiagnosticsFailure = {
  provider: string;
  modelId: string;
  count: number;
  statuses: string[];
  errorKinds: string[];
  errorCodes: string[];
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
  pendingInterventionCount: number;
  tokenBudgetState: string;
  costBudgetState: string;
  tokensUsed: number;
  costUsedMicros: number;
  currency?: string;
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
};
