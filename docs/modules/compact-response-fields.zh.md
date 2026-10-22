# 紧凑响应的按需字段，以及 Autotask `IncludeFields` 的坑

代码路径/区域：`src/utils/response.formatter.ts`（`pickSummaryFields`、`formatCompactResponse`、`extraFields`）；`src/handlers/tool.handler.ts`（`COMPACT_SEARCH_TOOLS` 共享调用点，以及任何想在紧凑响应里暴露一个平时隐藏字段的单个工具处理分支）。

## PRD-20317 · 2026-10-21（返工，r2）

**事实 1 —— 紧凑响应上的按需额外字段，完全属于 formatter 这一层，不属于 Autotask 查询这一层。** `pickSummaryFields(item, entityType, extraFields)`（`src/utils/response.formatter.ts:39-78`，写下本文时尚未合入 `main`——见下方 sha 说明）会把 `extraFields` 里点名的字段从**原始** item 拷到紧凑 item 上，这是在该实体固定的 `SUMMARY_FIELDS` 白名单之外额外做的事。传进来的原始 item 本来就已经带着 Autotask 对这次查询返回的所有字段——只要查询完全不带 `IncludeFields`，Autotask 默认就会把一切都返回（包括 `userDefinedFields` 这类很少用到的字段）。formatter 的 `extraFields` 白名单管的是**紧凑**响应要不要瘦身，不需要、也不应该靠在 Autotask 那一侧发一个更窄的请求来配合。

**事实 2 —— Autotask 的 `IncludeFields` 查询参数拒绝 `userDefinedFields` 这个值。** 已对真实 Autotask 实例现网确认：QA comment `90170265051691`（Minnie Zhou，2026-10-21，INT `autotask-mcp main@29d71f7`）—— `IncludeFields` 里含 `'userDefinedFields'` 的查询会返回 HTTP 500 `Unable to find userDefinedFields in the Contact Entity`。这个结论是专门针对 `Contacts` 实体确认的；没有对其它带 UDF 的实体（`Companies`、`Tickets` 等）测过，不应不经现网验证就假设那边也一样安全。

**对后续工单的影响**：如果其它 `COMPACT_SEARCH_TOOLS` 实体（tickets、companies、projects、tasks、resources、billing items、time entries）需要在紧凑响应上加一个按需额外字段，只照着 `extraFields` 这套穿线方式做（handler 从 args 里剥离 flag → 调用 service 时不带 `includeFields` 覆盖 → 共享的紧凑响应调用点根据 flag 算出 `extraFields` 并传给 `formatCompactResponse`）。**不要**再试图通过 Autotask 查询的 `IncludeFields` 参数去强制带上这个字段，除非已经针对那个具体实体、那个具体字段名在 `IncludeFields` 里的可接受性做过现网确认——这张单自己的 r1（`83091b7`）就是在 `userDefinedFields`/`Contacts` 上犯了一模一样的错误，而且一路发到了 INT 才被抓到。

### `path:line` 引用

（基于 `dev01.mbagent/PRD-20317` 分支上的提交 `9577159`——写下本文时**尚未合入 `main`**；本轮落地后请对着 `main` 重新核对，`docs/` 条目可能过期的老规矩同样适用。）

- `src/utils/response.formatter.ts:39-78` —— `pickSummaryFields`、`extraFields` 的处理逻辑。
- `src/handlers/tool.handler.ts:904-915` —— `autotask_search_contacts` 处理分支（r2 修复后：绝不设置 `includeFields`）。
- `src/handlers/tool.handler.ts:1780-1796` —— 共享的紧凑响应调用点；`extraFields` 由 `args.includeUserDefinedFields` 算出，对其它所有 `COMPACT_SEARCH_TOOLS` 条目都是 `undefined`。
- `src/services/autotask-http.ts:301-302` —— 产生 QA 引用的那段原文报错文字的错误信息拼装逻辑（`Autotask {method} {path} failed: HTTP {status}: {detail}`）。
