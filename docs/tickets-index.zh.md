# 工单索引

每份 `docs/tickets/PRD-XXXXX.md` 对应一行，记录它还在工作分支上开着，还是合并/发布后已冻结。由 PRD-20620（2026-10-21）首次建立——PRD-20217 是补记的，因为它在本仓库里本来就已经存在。

| 工单 | 状态 | 工作分支 | 备注 |
| PRD-20217 | 冻结 @ 5c34372 | `dev01.mbagent/PRD-20217` | 只有英文文档（`PRD-20217.md`）——早于 2026-10-08 的中英双版规矩，不做追溯补档 |
| PRD-20620 | 冻结 @ 43c0078 | `dev01.mbagent/PRD-20620` | `autotask_assign_least_loaded_resource`；r2 返工以 `PRD-20620-r2.md` 取代第一轮的 `PRD-20620.md`（破坏性契约改动）；详见 `docs/modules/ticket-assignment.zh.md` |
| PRD-20317 | 冻结 @ 40c2967（r2） | `dev01.mbagent/PRD-20317` | `autotask_search_contacts` 的 `includeUserDefinedFields`；r1（`PRD-20317.md`，冻结 @ b1b9b6a）发布的 `IncludeFields` 超集在现网被 Autotask 拒绝、报 HTTP 500；r2（`PRD-20317-r2.md`）移除了它，修正了测试 mock 使其贴近真实行为，并留了一个待报告人确认的 TC3 问题；详见 `docs/modules/compact-response-fields.zh.md` |
