# 工单索引

每份 `docs/tickets/PRD-XXXXX.md` 对应一行，记录它还在工作分支上开着，还是合并/发布后已冻结。由 PRD-20620（2026-10-21）首次建立——PRD-20217 是补记的，因为它在本仓库里本来就已经存在。

| 工单 | 状态 | 工作分支 | 备注 |
| PRD-20217 | 冻结 @ 5c34372 | `dev01.mbagent/PRD-20217` | 只有英文文档（`PRD-20217.md`）——早于 2026-10-08 的中英双版规矩，不做追溯补档 |
| PRD-20620 | 冻结 @ d08d8fa | `dev01.mbagent/PRD-20620` | `autotask_assign_least_loaded_resource`；r2 返工以 `PRD-20620-r2.md` 取代第一轮的 `PRD-20620.md`（破坏性契约改动）；代码评审跟进（同一轮，验收标准未变）重新冻结于 `d08d8fa`（原为 `43c0078`）；详见 `docs/modules/ticket-assignment.zh.md` |
