# 模块：工单分配

记录这个仓库是怎么决定一张工单**该分给谁**的累积事实。这份文档永不冻结；每张改动这块区域的工单都用追加小节的方式写进来。下面每条陈述都带 `main` 分支上的 `path:line` + commit sha——采信前先核对那一行是否还在、内容是否还对；对不上就当"未覆盖"处理并如实说明，不要照抄继续往下传。

## PRD-20620 · 2026-10-21

- 在这张单之前，`autotask_create_ticket`/`autotask_update_ticket` 把 `assignedResourceID` 当作调用方直接传入的普通数字，调用之间没有任何协调机制（`src/handlers/tool.definitions.ts:553,664` @ `851f6bd`）。同一个 agent 回合里并发或连续快速发出的调用会可靠地全部落到同一个技术人员身上，因为 LLM 没有办法让自己的工具调用互相排队。
- `autotask_assign_least_loaded_resource`（`src/handlers/tool.handler.ts` 的分发条目，加于 `2601250`）是这个仓库第一段按"队列 → 资源"方向查询 `ResourceRoles` 的代码。"资源 → 角色"方向（`searchResourceRoles`，`src/services/autotask.service.ts:947` @ `851f6bd`）早就存在；反方向此前从未被用到过。两个方向查的是同一个 `ResourceRoles` 实体，它的每一条（资源、角色、队列）分配记录上都直接带着 `queueID`（`src/types/autotask.ts:739` @ `851f6bd`）。
- 计数时"未结"工单的定义是 `status != 5`（Complete）——和 `searchTickets` 已有的约定一致（`src/services/autotask.service.ts:476` @ `851f6bd`）。如果这个仓库以后新增了其它终态状态，`countOpenTicketsByQueueAndResource`（`src/services/autotask.service.ts`，加于 `2601250`）需要跟着同步更新这个定义，否则两个工具对"什么算未结"会产生分歧。
- **串行化用的锁只在进程内生效**（`src/utils/queue-lock.ts`，加于 `2601250`）。它防的是**同一个**服务进程内并发调用之间的竞态；如果这个服务以后对同一个 Autotask 租户部署多个副本，它**不能**防住跨副本的竞态。截至 `2601250`，`docker-compose.yml` 显示的是单个服务、没有副本数配置——如果这一点以后变了，这把锁就不够用了，下一张碰到这里的工单需要换成共享锁（数据库行锁或 Redis），而不是把进程内锁做大。
- 通过这个工具新建的工单必须在 create payload 里显式设置 `queueID`——否则一张全新的工单没有别的办法落进"它的受理人资格正是照这个队列核验的"那个队列。通过 `ticketID` 路径改派的既有工单则被假定本来就在那个队列里，不会被重新打上队列标记。

## PRD-20620-r2 · 2026-10-21

**以下内容替代了上面大部分 round 1 的事实**（需求变更，round 1 发布数小时后提出——见 `docs/tickets/PRD-20620-r2.md` 的「返工判断」一节）。round 1 的记录保留作历史，但已不再描述当前行为；下面的事实以 `dev01.mbagent/PRD-20620` 本单提交时的树为准。

- `getEligibleResourcesForQueue`（上面 round 1 记录的"队列 → 资源"`ResourceRoles` 查询）和 `countOpenTicketsByQueueAndResource` 都已**移除**——这个工具不再查询 Autotask 来发现谁有资格。调用方直接以 `technicians: {resourceID, roleID}[]` 的形式提供候选名单（`src/handlers/tool.definitions.ts`，本单提交）。"资源 → 角色"方向（`searchResourceRoles`）未受影响，仍被别处使用（例如 `autotask_create_ticket`/`autotask_update_ticket` 的 `fillAssignedResourceRole`）。
- "匹配"（取代 round 1 固定的"未结" = `status != 5`）现在由调用方的 `status` 参数决定，可选用 `queueIDs` 进一步收窄。`countMatchingTicketsByResource(status, queueIDs, resourceIDs)`（`src/services/autotask.service.ts`，本单提交）据此拼接 `Tickets` 查询过滤条件——`status eq <status>` 始终存在，只有 `queueIDs` 给定且非空时才加 `queueID in queueIDs`。不再有需要和 `searchTickets` 保持同步的硬编码"Complete"假设。
- 角色解析这一步（`fillAssignedResourceRole` → `resolveRoleForResource` → Autotask 的 `Roles` 查询）**对这个工具不再调用**。调用方在 `technicians` 数组里为每个候选人提供 `roleID`，直接原样回填进 `assignedResourceRoleID`——工具照单全收，和 round 1 之前 create/update 工具已经信任调用方传入的 `assignedResourceID` 是同一个做法。
- 进程内锁（`src/utils/queue-lock.ts`，round 1 记录的机制本身未变）现在的 key 是 `status`、排序后的 `queueIDs`、排序后的 `technicians[].resourceID` 三者的组合——不再只是 `queueID`。两个技术人员/状态/队列组合彼此不相交的调用不再互相等待，即便按 round 1 的 key 它们本来会共享同一个队列。
- `NoEligibleResourceError`（round 1 记录，一个 Autotask 查询结果错误）被 `NoCandidateTechniciansError` 取代（一个调用方输入错误，在任何 Autotask 调用之前就抛出）——这个区别很关键，因为 r2 把"谁有资格"的判断责任从这个工具移交给了调用方。
- 这是对一个**已经发布到生产环境**的契约做的**破坏性改动**（round 1 发布后数小时，据 Lucas Chen 的评论）。没有引入 feature flag 或双契约过渡期——可接受的影响面见 `docs/tickets/PRD-20620-r2.md` 的「上线与回滚」一节。
