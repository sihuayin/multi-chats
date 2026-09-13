"use client";

// Three variants of the Discussion workspace, switchable via ?variant=.

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleStop,
  FileJson,
  MessageSquareText,
  RefreshCw,
  Sparkles
} from "lucide-react";
import styles from "./prototype.module.css";

const variants = ["A", "B", "C"] as const;
type Variant = (typeof variants)[number];
type Stage = "setup" | "positions" | "cross" | "synthesis" | "review";

const stageOrder: Array<{ id: Stage; label: string }> = [
  { id: "setup", label: "配置" },
  { id: "positions", label: "观点" },
  { id: "cross", label: "交叉回应" },
  { id: "synthesis", label: "综合" },
  { id: "review", label: "确认" }
];

const participants = [
  {
    name: "林澈",
    role: "Analyst",
    objective: "拆解记忆需求边界",
    accent: "AL"
  },
  {
    name: "周研",
    role: "Researcher",
    objective: "补充事实与来源",
    accent: "RE"
  },
  {
    name: "沈疑",
    role: "Skeptic",
    objective: "挑战收益假设",
    accent: "SK"
  },
  {
    name: "顾言",
    role: "Designer",
    objective: "设计最小实现路径",
    accent: "DE"
  },
  {
    name: "程舟",
    role: "Facilitator",
    objective: "收敛分歧并形成建议",
    accent: "FA"
  }
];

const positions = [
  {
    name: "林澈",
    role: "Analyst",
    summary: "问题不是“要不要记忆”，而是哪些上下文值得跨会话保留。",
    items: ["先定义可保留的最小单位", "区分事实、决策与临时讨论"]
  },
  {
    name: "周研",
    role: "Researcher",
    summary: "现有方案都依赖检索质量，缺少可解释的晋升规则。",
    items: ["需要来源和过期策略", "证据应能追溯到原始 Discussion"]
  },
  {
    name: "沈疑",
    role: "Skeptic",
    summary: "跨会话记忆会放大错误、隐私和时间衰减问题。",
    items: ["错误事实可能被永久传播", "必须先有用户审核边界"]
  },
  {
    name: "顾言",
    role: "Designer",
    summary: "可以先做显式记忆，不做自动检索和隐式写入。",
    items: ["由用户将 Brief 标记为可复用", "按 Workspace 与 Task 建立作用域"]
  }
];

const crossResponses = [
  {
    name: "林澈",
    response: "同意先做显式记忆，但需要定义“决策”与“事实”的不同生命周期。"
  },
  {
    name: "周研",
    response: "证据引用必须保留 Artifact revision，否则后续无法解释为何采用该结论。"
  },
  {
    name: "沈疑",
    response: "建议默认关闭跨会话复用，用户在 Brief 上显式批准后才进入候选记忆。"
  },
  {
    name: "顾言",
    response: "第一阶段只提供“从 Discussion 创建可复用 Brief”，暂不做向量检索。"
  }
];

const briefOptions = [
  {
    id: "explicit-brief-memory",
    title: "显式 Brief 记忆",
    summary: "仅允许用户确认过的 Discussion Brief 进入可复用知识范围。",
    tradeoff: "收益明确、容易审计；需要额外确认步骤。",
    recommended: true
  },
  {
    id: "auto-summary",
    title: "自动摘要记忆",
    summary: "系统自动提炼每轮讨论并写入记忆。",
    tradeoff: "体验更轻；错误传播和不可解释性更高。",
    recommended: false
  },
  {
    id: "task-scope",
    title: "仅 Task 作用域",
    summary: "记忆只跟 Task 生命周期绑定，不跨会话复用。",
    tradeoff: "风险最低；无法支持长期团队知识。",
    recommended: false
  }
];

type Participant = (typeof participants)[number];
type Position = (typeof positions)[number];
type CrossResponse = (typeof crossResponses)[number];
type BriefOption = (typeof briefOptions)[number];

function DiscussionPrototypeInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawVariant = searchParams.get("variant")?.toUpperCase();
  const variant: Variant = variants.includes(rawVariant as Variant)
    ? (rawVariant as Variant)
    : "A";
  const [stage, setStage] = useState<Stage>("setup");
  const [stopped, setStopped] = useState(false);
  const [extended, setExtended] = useState(false);
  const [taskCreated, setTaskCreated] = useState(false);
  const [topic, setTopic] = useState("是否为 Multi-Chats 引入跨会话记忆");
  const [mode, setMode] = useState("problem");

  const stageIndex = stageOrder.findIndex((item) => item.id === stage);
  const nextStage = stageOrder[Math.min(stageIndex + 1, stageOrder.length - 1)]?.id;

  function moveVariant(direction: number) {
    const index = variants.indexOf(variant);
    const next = variants[(index + direction + variants.length) % variants.length];
    const params = new URLSearchParams(searchParams.toString());
    params.set("variant", next);
    router.replace(`/prototype/discussion?${params.toString()}`);
  }

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches(
          "input, textarea, select, [contenteditable='true']"
        )
      ) {
        return;
      }
      if (event.key === "ArrowLeft") moveVariant(-1);
      if (event.key === "ArrowRight") moveVariant(1);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  const shared = {
    stage,
    stageIndex,
    nextStage,
    stopped,
    extended,
    taskCreated,
    topic,
    mode,
    participants,
    positions,
    crossResponses,
    briefOptions,
    onTopicChange: setTopic,
    onModeChange: setMode,
    onNext: () => {
      if (stopped) return;
      if (nextStage) setStage(nextStage);
    },
    onStop: () => setStopped(true),
    onResume: () => setStopped(false),
    onExtend: () => {
      setExtended(true);
      setStopped(false);
      setStage("cross");
    },
    onConfirm: () => setTaskCreated(true)
  };

  return (
    <div className={styles.shell}>
      {variant === "A" ? <VariantA {...shared} /> : null}
      {variant === "B" ? <VariantB {...shared} /> : null}
      {variant === "C" ? <VariantC {...shared} /> : null}
      {process.env.NODE_ENV !== "production" ? (
        <div className={styles.switcher}>
          <button onClick={() => moveVariant(-1)} aria-label="Previous variant">
            <ArrowLeft size={16} />
          </button>
          <span>
            {variant} ·{" "}
            {variant === "A"
              ? "Control room"
              : variant === "B"
                ? "Discussion document"
                : "Stage tabs"}
          </span>
          <button onClick={() => moveVariant(1)} aria-label="Next variant">
            <ArrowRight size={16} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

type SharedProps = {
  stage: Stage;
  stageIndex: number;
  nextStage?: Stage;
  stopped: boolean;
  extended: boolean;
  taskCreated: boolean;
  topic: string;
  mode: string;
  participants: Participant[];
  positions: Position[];
  crossResponses: CrossResponse[];
  briefOptions: BriefOption[];
  onTopicChange: (topic: string) => void;
  onModeChange: (mode: string) => void;
  onNext: () => void;
  onStop: () => void;
  onResume: () => void;
  onExtend: () => void;
  onConfirm: () => void;
};

function StageProgress({
  stageIndex,
  compact = false
}: {
  stageIndex: number;
  compact?: boolean;
}) {
  return (
    <div className={compact ? styles.progressCompact : styles.progress}>
      {stageOrder.map((item, index) => (
        <span
          key={item.id}
          className={
            index === stageIndex
              ? styles.progressActive
              : index < stageIndex
                ? styles.progressDone
                : ""
          }
        >
          <i>{index + 1}</i>
          {item.label}
        </span>
      ))}
    </div>
  );
}

function SetupFields({
  topic,
  mode,
  onTopicChange,
  onModeChange
}: Pick<
  SharedProps,
  "topic" | "mode" | "onTopicChange" | "onModeChange"
>) {
  return (
    <div className={styles.setupFields}>
      <label>
        <span>讨论议题</span>
        <input value={topic} onChange={(event) => onTopicChange(event.target.value)} />
      </label>
      <label>
        <span>讨论模式</span>
        <select value={mode} onChange={(event) => onModeChange(event.target.value)}>
          <option value="requirements">需求分析</option>
          <option value="problem">问题诊断</option>
          <option value="solution">方案设计</option>
          <option value="review">方案评审</option>
        </select>
      </label>
    </div>
  );
}

function ParticipantList({ participants }: { participants: Participant[] }) {
  return (
    <div className={styles.participants}>
      {participants.map((participant, index) => (
        <div key={participant.name} className={styles.participant}>
          <span>{participant.accent}</span>
          <div>
            <strong>
              {index + 1}. {participant.name}
            </strong>
            <small>{participant.role} · {participant.objective}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function StageActions({
  stage,
  stopped,
  taskCreated,
  onNext,
  onStop,
  onResume,
  onExtend,
  onConfirm
}: Pick<
  SharedProps,
  | "stage"
  | "stopped"
  | "taskCreated"
  | "onNext"
  | "onStop"
  | "onResume"
  | "onExtend"
  | "onConfirm"
>) {
  return (
    <div className={styles.actions}>
      {!stopped && stage !== "review" ? (
        <button className={styles.primaryButton} onClick={onNext}>
          {stage === "setup" ? <Sparkles size={15} /> : <ArrowRight size={15} />}
          {stage === "setup"
            ? "开始讨论"
            : stage === "positions"
              ? "进入交叉回应"
              : stage === "cross"
                ? "生成综合"
                : "查看 Brief"}
        </button>
      ) : null}
      {!stopped && stage !== "setup" && stage !== "review" ? (
        <button className={styles.quietButton} onClick={onStop}>
          <CircleStop size={15} />
          停止
        </button>
      ) : null}
      {stopped ? (
        <button className={styles.primaryButton} onClick={onResume}>
          <RefreshCw size={15} />
          继续讨论
        </button>
      ) : null}
      {stage === "review" && !taskCreated ? (
        <>
          <button className={styles.quietButton} onClick={onExtend}>
            追加一轮
          </button>
          <button className={styles.primaryButton} onClick={onConfirm}>
            <Check size={15} />
            确认并创建 Task
          </button>
        </>
      ) : null}
      {taskCreated ? (
        <span className={styles.successState}>
          <Check size={14} />
          Task 已创建
        </span>
      ) : null}
    </div>
  );
}

function VariantA(props: SharedProps) {
  const {
    stage,
    stageIndex,
    stopped,
    taskCreated,
    topic,
    mode,
    participants,
    positions,
    crossResponses,
    briefOptions
  } = props;
  return (
    <div className={styles.variant}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Variant A · 控制台</span>
          <h1>{topic || "未命名讨论"}</h1>
          <p>mode / {mode} · 5 位参与者 · 已使用 1 / 3 轮</p>
        </div>
        <StageProgress stageIndex={stageIndex} compact />
      </header>
      <div className={styles.controlGrid}>
        <aside className={styles.sideColumn}>
          <div className={styles.sectionLabel}>参与者与角色</div>
          <ParticipantList participants={participants} />
          {stopped ? <div className={styles.interrupted}>已停止 · 可追加约束后继续</div> : null}
        </aside>
        <main className={styles.centerColumn}>
          {stage === "setup" ? (
            <section className={styles.setupCard}>
              <span className={styles.sectionLabel}>讨论配置</span>
              <SetupFields
                topic={props.topic}
                mode={props.mode}
                onTopicChange={props.onTopicChange}
                onModeChange={props.onModeChange}
              />
              <div className={styles.modePreview}>
                <strong>问题诊断</strong>
                <span>提取事实、假设、根因候选与验证路径。</span>
              </div>
            </section>
          ) : null}
          {stage === "positions" ? (
            <section>
              <div className={styles.sectionHeading}>
                <span>Round 1 · Positions</span>
                <small>顺序发言，后发言者可见前文</small>
              </div>
              <div className={styles.positionList}>
                {positions.map((position) => (
                  <article key={position.name}>
                    <strong>{position.name}</strong>
                    <span>{position.role}</span>
                    <p>{position.summary}</p>
                    <ul>
                      {position.items.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
          {stage === "cross" ? (
            <section>
              <div className={styles.sectionHeading}>
                <span>Round 2 · Cross-response</span>
                <small>回应冲突，补充遗漏</small>
              </div>
              <div className={styles.responseList}>
                {crossResponses.map((response) => (
                  <article key={response.name}>
                    <strong>{response.name}</strong>
                    <p>{response.response}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
          {stage === "synthesis" || stage === "review" ? (
            <section className={styles.synthesisSection}>
              <span className={styles.sectionLabel}>Facilitator synthesis</span>
              <h2>建议先做显式 Brief 记忆，不做自动检索。</h2>
              <p>
                用户确认过的 Discussion Brief 才可复用，保留来源 Revision，
                默认关闭跨会话记忆。
              </p>
              <div className={styles.disagreement}>
                <strong>仍有分歧</strong>
                <span>事实记忆的过期策略尚未确定。</span>
              </div>
            </section>
          ) : null}
          <StageActions
            stage={stage}
            stopped={stopped}
            taskCreated={taskCreated}
            onNext={props.onNext}
            onStop={props.onStop}
            onResume={props.onResume}
            onExtend={props.onExtend}
            onConfirm={props.onConfirm}
          />
        </main>
        <aside className={styles.outputColumn}>
          <div className={styles.sectionLabel}>Discussion Brief</div>
          <div className={styles.briefPreview}>
            <span>revision 1</span>
            <strong>是否引入跨会话记忆</strong>
            <p>核心结论、候选方案和风险会在这里持续汇总。</p>
          </div>
          {stage === "review" ? (
            <div className={styles.optionStack}>
              {briefOptions.map((option) => (
                <article
                  key={option.id}
                  className={option.recommended ? styles.recommended : ""}
                >
                  <strong>{option.title}</strong>
                  <p>{option.summary}</p>
                  <small>{option.tradeoff}</small>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.emptyBrief}>
              <FileJson size={18} />
              <span>完成 Synthesis 后生成结构化 Brief。</span>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function VariantB(props: SharedProps) {
  const {
    stage,
    stageIndex,
    stopped,
    taskCreated,
    topic,
    mode,
    participants,
    positions,
    crossResponses,
    briefOptions
  } = props;
  return (
    <div className={styles.variant}>
      <header className={styles.documentHeader}>
        <span className={styles.eyebrow}>Variant B · 讨论文档</span>
        <h1>{topic || "未命名讨论"}</h1>
        <div className={styles.documentMeta}>
          <span>{mode}</span>
          <span>5 Participants</span>
          <span>Facilitator · 程舟</span>
          <span>Round {Math.min(stageIndex, 3)} / 3</span>
        </div>
        <StageProgress stageIndex={stageIndex} />
      </header>
      <div className={styles.readerGrid}>
        <main className={styles.documentBody}>
          {stage === "setup" ? (
            <section className={styles.documentSetup}>
              <h2>建立讨论边界</h2>
              <SetupFields
                topic={props.topic}
                mode={props.mode}
                onTopicChange={props.onTopicChange}
                onModeChange={props.onModeChange}
              />
              <ParticipantList participants={participants} />
            </section>
          ) : null}
          {stage !== "setup" ? (
            <>
              <section className={styles.documentRound}>
                <div className={styles.roundMarker}>01</div>
                <div>
                  <span className={styles.sectionLabel}>Positions</span>
                  <h2>先把问题拆开，而不是急着给答案</h2>
                  {positions.slice(0, 3).map((position) => (
                    <div key={position.name} className={styles.readerTurn}>
                      <strong>{position.name}</strong>
                      <p>{position.summary}</p>
                    </div>
                  ))}
                </div>
              </section>
              {stage === "cross" || stage === "synthesis" || stage === "review" ? (
                <section className={styles.documentRound}>
                  <div className={styles.roundMarker}>02</div>
                  <div>
                    <span className={styles.sectionLabel}>Cross-response</span>
                    <h2>分歧集中在自动写入与错误传播</h2>
                    {crossResponses.slice(0, 3).map((response) => (
                      <div key={response.name} className={styles.readerTurn}>
                        <strong>{response.name}</strong>
                        <p>{response.response}</p>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              {stage === "synthesis" || stage === "review" ? (
                <section className={styles.documentRound}>
                  <div className={styles.roundMarker}>03</div>
                  <div>
                    <span className={styles.sectionLabel}>Synthesis</span>
                    <h2>推荐方案：显式 Brief 记忆</h2>
                    <p className={styles.lead}>
                      先让用户确认哪些 Discussion 成果值得复用，保留来源与版本。
                    </p>
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
          <StageActions
            stage={stage}
            stopped={stopped}
            taskCreated={taskCreated}
            onNext={props.onNext}
            onStop={props.onStop}
            onResume={props.onResume}
            onExtend={props.onExtend}
            onConfirm={props.onConfirm}
          />
        </main>
        <aside className={styles.marginNotes}>
          <div>
            <span className={styles.sectionLabel}>Participants</span>
            <ParticipantList participants={participants} />
          </div>
          <div className={styles.briefMargin}>
            <span className={styles.sectionLabel}>Latest Brief</span>
            {stage === "synthesis" || stage === "review" ? (
              <>
                <strong>显式 Brief 记忆</strong>
                <p>可审计、可追溯、默认关闭。</p>
                <small>Revision 1</small>
              </>
            ) : (
              <p>等待 Synthesis。</p>
            )}
          </div>
          {stage === "review" ? (
            <div className={styles.optionStack}>
              {briefOptions.map((option) => (
                <article key={option.id}>
                  <strong>{option.title}</strong>
                  <small>{option.recommended ? "推荐" : option.tradeoff}</small>
                </article>
              ))}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function VariantC(props: SharedProps) {
  const {
    stage,
    stageIndex,
    stopped,
    taskCreated,
    topic,
    mode,
    participants,
    positions,
    crossResponses,
    briefOptions
  } = props;
  return (
    <div className={`${styles.variant} ${styles.stageShell}`}>
      <header className={styles.stageHeader}>
        <div>
          <span className={styles.eyebrow}>Variant C · 阶段工作台</span>
          <h1>{topic || "未命名讨论"}</h1>
        </div>
        <div className={styles.stageBadge}>
          <span>{mode}</span>
          <strong>Round {Math.min(stageIndex, 3)} / 3</strong>
        </div>
      </header>
      <nav className={styles.stageTabs}>
        {stageOrder.map((item, index) => (
          <span
            key={item.id}
            className={index === stageIndex ? styles.stageTabActive : ""}
          >
            <i>{String(index + 1).padStart(2, "0")}</i>
            {item.label}
          </span>
        ))}
      </nav>
      <div className={styles.stageGrid}>
        <aside className={styles.stageRail}>
          <div className={styles.sectionLabel}>Participants</div>
          <ParticipantList participants={participants} />
          <div className={styles.budgetBox}>
            <span>讨论预算</span>
            <strong>3 / 5 轮</strong>
            <i><b style={{ width: `${Math.max(stageIndex, 1) * 20}%` }} /></i>
          </div>
        </aside>
        <main className={styles.stageContent}>
          {stage === "setup" ? (
            <>
              <span className={styles.sectionLabel}>Define the discussion</span>
              <h2>先确定问题边界，再选择参与者。</h2>
              <SetupFields
                topic={props.topic}
                mode={props.mode}
                onTopicChange={props.onTopicChange}
                onModeChange={props.onModeChange}
              />
            </>
          ) : null}
          {stage === "positions" ? (
            <>
              <span className={styles.sectionLabel}>Positions</span>
              <h2>独立判断</h2>
              <div className={styles.stackedTurns}>
                {positions.map((position) => (
                  <article key={position.name}>
                    <strong>{position.name}</strong>
                    <span>{position.role}</span>
                    <p>{position.summary}</p>
                  </article>
                ))}
              </div>
            </>
          ) : null}
          {stage === "cross" ? (
            <>
              <span className={styles.sectionLabel}>Cross-response</span>
              <h2>聚焦冲突与遗漏</h2>
              <div className={styles.responseGrid}>
                {crossResponses.map((response) => (
                  <article key={response.name}>
                    <strong>{response.name}</strong>
                    <p>{response.response}</p>
                  </article>
                ))}
              </div>
            </>
          ) : null}
          {stage === "synthesis" || stage === "review" ? (
            <>
              <span className={styles.sectionLabel}>Synthesis</span>
              <h2>显式 Brief 记忆是当前最稳妥的收敛点。</h2>
              <p className={styles.lead}>
                保留用户确认与来源版本，暂不进入自动检索和隐式写入。
              </p>
              <div className={styles.optionStack}>
                {briefOptions.map((option) => (
                  <article
                    key={option.id}
                    className={option.recommended ? styles.recommended : ""}
                  >
                    <strong>{option.title}</strong>
                    <p>{option.summary}</p>
                    <small>{option.tradeoff}</small>
                  </article>
                ))}
              </div>
            </>
          ) : null}
          <StageActions
            stage={stage}
            stopped={stopped}
            taskCreated={taskCreated}
            onNext={props.onNext}
            onStop={props.onStop}
            onResume={props.onResume}
            onExtend={props.onExtend}
            onConfirm={props.onConfirm}
          />
        </main>
        <aside className={styles.outputDrawer}>
          <span className={styles.sectionLabel}>
            <MessageSquareText size={14} />
            Brief output
          </span>
          <strong>显式 Brief 记忆</strong>
          <p>用户确认后才允许跨 Conversation 复用。</p>
          <div className={styles.outputStats}>
            <span>3 options</span>
            <span>1 open question</span>
            <span>Revision 1</span>
          </div>
          {stage === "review" ? (
            <div className={styles.taskPreview}>
              <span>Task preview</span>
              <strong>引入显式 Brief 记忆</strong>
              <small>Facilitator + 4 participants · draft</small>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

export function DiscussionPrototype() {
  return <DiscussionPrototypeInner />;
}
