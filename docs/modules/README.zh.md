# 模块文档索引

把本仓库里的某段代码路径 / 产品区域映射到记录"为什么这么设计、有什么约束、下一次改动要知道什么"的模块文档——这是跨越单张工单、会一直累积下去的事实。单张工单自己的设计/自测记录在 `docs/tickets/` 下；这份索引只放"活得比某一张工单更久"的事实。

| 代码路径 / 区域 | 模块文档 |
| `src/handlers/tool.handler.ts` 里工单分配相关的分发条目、`src/services/autotask.service.ts` 的候选人/计数查询、`src/utils/queue-lock.ts` | `ticket-assignment.zh.md` |
| `src/utils/response.formatter.ts` 紧凑响应的 `extraFields`、`src/handlers/tool.handler.ts` 共享的 `COMPACT_SEARCH_TOOLS` 调用点与各工具自己按需加字段的处理分支 | `compact-response-fields.zh.md` |

后续工单碰到新的、值得这样追踪的区域时在这里追加一行——第一条的来历见 `docs/tickets/PRD-20620.zh.md` 的「交接」一节。
