# Multi-Chats

[English](README.md) · **简体中文**

一个自托管工作区：配置 AI 员工、把它们组织成分组，并在会话中协作完成任务。

![会话中心：一条会话中提及了员工，每位员工在消息流中回复，右侧同时展示该会话的任务、产物与运行时间线。](docs/images/conversation-zh.png)

## 界面截图

| Discussions | 员工 |
| --- | --- |
| ![审核中的 Discussion：参与者及其角色、各回合的阶段进度、Token 与成本预算，以及带推荐选项和证据索引的版本化简报。](docs/images/discussion-zh.png) | ![员工：每位员工绑定一个模型配置和一组技能，并可配置有序的回退目标。](docs/images/employees-zh.png) |
| **分组** | **技能** |
| ![分组：可复用的成员模板，新建会话会复制其成员。](docs/images/groups-zh.png) | ![技能：声明式指令与工具白名单，分为内置和自建两类。](docs/images/skills-zh.png) |
| **工具** | **模型提供商** |
| ![工具：任何外部操作都必须先在此注册，技能才能调用；卡片展示内置与已注册工具的风险、审批与重放策略。](docs/images/tools-zh.png) | ![模型提供商：员工运行时使用的模型提供商凭据。](docs/images/providers-zh.png) |

## 本地开发

环境要求：

- Node 22（`nvm use`）
- 仅在运行 PostgreSQL 技术栈时需要 Docker

本地开发默认使用 SQLite，数据库文件位于 `.data/multi-chats.sqlite`。

```bash
npm install
npm run db:migrate
npm run dev
```

在第二个终端中运行 worker：

```bash
npm run worker
```

设置 `MODEL_MODE=fake` 可使用确定性的测试响应，替代真实模型调用。

界面支持英文和中文。初始语言来自 `locale` cookie 或浏览器的 `Accept-Language` 请求头，也可以在侧边栏中切换。

## PostgreSQL

设置 `DATABASE_URL` 即可把同一个应用和 worker 切换到 PostgreSQL：

```bash
DATABASE_URL=postgres://multi_chats:multi_chats@localhost:5432/multi_chats npm run db:migrate
DATABASE_URL=postgres://multi_chats:multi_chats@localhost:5432/multi_chats npm run worker
```

## 自托管部署

启动技术栈之前，设置一个持久化的 32 字节 base64 加密密钥：

```bash
export APP_ENCRYPTION_KEY="$(openssl rand -base64 32)"
docker compose up --build -d
```

Compose 会同时启动 PostgreSQL、Web 进程和 worker。Web 进程的健康检查读取
`/api/health`；两个应用服务都会在启动前执行数据库迁移。需要时可通过环境变量
覆盖 `WEB_PORT`、`POSTGRES_PORT` 或 `MODEL_MODE`。

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

运行完整的验收流程：

```bash
VERIFY_BASE_URL=http://localhost:3000 \
VERIFY_COMPOSE_PROJECT=multi-chats \
npm run verify:acceptance
```

`verify:deployment` 检查健康状态、单活动 Run 不变式、备份与恢复、服务重启和部署
日志。设置 `VERIFY_COMPOSE_START=1` 可在该次运行中构建并启动 Compose 项目。未设置
`VERIFY_COMPOSE_PROJECT` 时，只运行 HTTP 健康检查和活动 Run 检查。

统一的真实 Provider 发布门禁需要显式开启，永不包含在默认命令中。它用一条命令同时
运行生产适配器的冒烟矩阵，并评估 Discussion 质量报告：

```bash
PROVIDER_SMOKE=1 \
RELEASE_GATE_PROFILE=network_constrained \
DEEPSEEK_API_KEY=... \
SMOKE_EVIDENCE_LINK=artifact://release-gate/42 \
npm run verify:release-gate
```

`network_constrained` 是默认档位，将主用和回退固定为 `deepseek-v4-flash` 与
`deepseek-v4-pro`。其报告记录 `crossFamilyFailoverVerified: false`，把 Anthropic
和 Google 标记为未验证，并且不能表示为与 standard 档位等价。
该命令会自动运行 Discussion 质量语料：四种模式，每种重复三次。只有在评估运维人员
产出的报告时才设置 `SMOKE_QUALITY_REPORT_PATH`；该报告必须恰好包含三次确定性运行，
并覆盖全部四种语料模式。

standard 档位要求显式指定目标，并且回退目标需同时覆盖 OpenAI 兼容和 Anthropic
两个家族：

```bash
PROVIDER_SMOKE=1 \
RELEASE_GATE_PROFILE=standard \
SMOKE_PRIMARY_PROVIDER=openai \
SMOKE_PRIMARY_MODEL=gpt-4o-mini \
SMOKE_PRIMARY_API_KEY=... \
SMOKE_FALLBACK_PROVIDER=anthropic \
SMOKE_FALLBACK_MODEL=claude-3-5-haiku \
SMOKE_FALLBACK_API_KEY=... \
SMOKE_EVIDENCE_LINK=artifact://release-gate/42 \
npm run verify:release-gate
```

设置 `SMOKE_MAX_TOTAL_TOKENS`、`SMOKE_MAX_COST_MICROS` 和
`SMOKE_PROVIDER_TIMEOUT_MS` 可以约束花费；达到任一上限后，矩阵会停止调度新的场景。
成本上限需要有费率才能生效，因此请把 `SMOKE_INPUT_MICROS_PER_MILLION_TOKENS` 和
`SMOKE_OUTPUT_MICROS_PER_MILLION_TOKENS` 设置为目标的真实费率，而不要沿用保守的
默认值。单一目标可以证明除故障切换之外的全部契约，故障切换会被报告为跳过；回退
目标必须同时覆盖 OpenAI 兼容和 Anthropic 两个家族，这样一个 Provider 的中断就无法
掩盖另一个损坏的适配器。

需要使用代理时，为进程设置标准的 `HTTPS_PROXY`/`HTTP_PROXY` 变量即可：冒烟矩阵
驱动的是与应用相同的生产适配器，因此不需要任何冒烟专用的代理配置。

`verify:provider-smoke` 和 `verify:discussion-quality` 仍然保留，用于聚焦的诊断。
常规 CI 从不设置 `PROVIDER_SMOKE`，因此统一门禁及其网络调用默认都处于跳过状态。

备份与恢复对两种存储后端都适用：

```bash
npm run db:backup -- backup.json
npm run db:restore -- backup.json
```

恢复命令会先校验必需的 Workspace 集合、实体字段、引用关系、状态以及受支持的
产物类型，然后才替换当前状态。端到端浏览器测试使用 SQLite、`MODEL_MODE=fake` 和
确定性的工具响应，因此不需要任何 Provider 凭据，也不产生外部网络副作用。
