// autotask_assign_least_loaded_resource (PRD-20620).
//
// The reported defect: when the agent processes several tickets "at the same
// time," ticket assignment was entirely the LLM's own per-call guess with no
// shared state, so concurrent assignments collapsed onto one technician
// instead of spreading across the queue's eligible team. This tool makes the
// pick deterministic (fewest open tickets in the queue, ties by lowest
// resourceID) and runs the read-then-write sequence behind a per-queue lock
// (src/utils/queue-lock.ts) so overlapping calls for the same queue serialize
// instead of racing on the same stale counts.
//
// Mocking strategy follows this repo's existing shape (see
// tests/resource-roles.test.ts): a real AutotaskService + AutotaskToolHandler
// against a routed `fetch` mock, not a mocked AutotaskService. ResourceRoles
// carries `queueID` directly per assignment row (src/types/autotask.ts:739),
// so one in-memory list of those rows answers both directions this tool
// needs: queue -> eligible resources (filtered by queueID) and
// resource -> role (filtered by resourceID, the existing path
// resolveRoleForResource/fillAssignedResourceRole already uses).

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { AutotaskToolHandler, NoEligibleResourceError } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');

const config: McpServerConfig = {
  name: 'test-server',
  version: '0.0.0',
  autotask: {
    username: 'user@example.com',
    secret: 'secret',
    integrationCode: 'integration-code',
    apiUrl: 'https://webservices2.autotask.net/ATServicesRest/',
  },
};

interface ResourceRoleRow {
  id: number;
  resourceID: number;
  roleID: number;
  queueID: number;
  isActive: boolean;
}

interface TicketRow {
  id: number;
  queueID: number;
  assignedResourceID: number;
  status: number;
}

const HELP_DESK_ROLE = 501;

/**
 * A `fetch` mock that answers ResourceRoles/Roles/Tickets by URL suffix, like
 * tests/resource-roles.test.ts's mockAutotask, but backed by mutable state so
 * a ticket created mid-test is counted by the NEXT count query — that state
 * mutation is exactly what AC4 depends on. `gate`, when given, defers the
 * resolution of the N-th (1-indexed) `Tickets/query` call until it resolves,
 * to force a controlled overlap window for the serialization test.
 */
function mockAutotask(opts: {
  resourceRoles: ResourceRoleRow[];
  tickets: TicketRow[];
  gateTicketsQueryCall?: number;
}): {
  calls: Array<{ path: string; method: string; body: any }>;
  tickets: TicketRow[];
  releaseGate: () => void;
} {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  const tickets = opts.tickets;
  let nextTicketId = Math.max(0, ...tickets.map(t => t.id)) + 1;
  let ticketsQueryCount = 0;
  let releaseGate: () => void = () => {};
  const gatePromise = new Promise<void>((resolve) => { releaseGate = resolve; });

  function findFilter(filters: any[], field: string): any {
    return filters.find((f: any) => f.field === field);
  }

  jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any, init: any) => {
    const path = String(url).replace(/^.*ATServicesRest\/?(v1\.0)?/, '');
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body });

    const ok = (payload: unknown) =>
      ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) } as unknown as Response);
    const notFound = () =>
      ({ ok: false, status: 404, headers: { get: () => null }, text: async () => `no route for ${path}` } as unknown as Response);

    if (method === 'POST' && path.endsWith('/ResourceRoles/query')) {
      const filters: any[] = body.filter || [];
      const queueFilter = findFilter(filters, 'queueID');
      const resourceFilter = findFilter(filters, 'resourceID');
      let rows = opts.resourceRoles;
      if (queueFilter) rows = rows.filter(r => r.queueID === queueFilter.value);
      if (resourceFilter) rows = rows.filter(r => r.resourceID === resourceFilter.value);
      rows = rows.filter(r => r.isActive);
      return ok({ items: rows, pageDetails: { count: rows.length } });
    }

    if (method === 'POST' && path.endsWith('/Roles/query')) {
      const filters: any[] = body.filter || [];
      const idFilter = findFilter(filters, 'id');
      const ids: number[] = idFilter?.value ?? [];
      const items = ids.map(id => ({ id, name: id === HELP_DESK_ROLE ? 'Help Desk' : `Role ${id}`, isActive: true }));
      return ok({ items, pageDetails: { count: items.length } });
    }

    if (method === 'POST' && path.endsWith('/Tickets/query')) {
      ticketsQueryCount += 1;
      if (opts.gateTicketsQueryCall === ticketsQueryCount) {
        await gatePromise;
      }
      const filters: any[] = body.filter || [];
      const queueFilter = findFilter(filters, 'queueID');
      const resourceFilter = findFilter(filters, 'assignedResourceID');
      const resourceIDs: number[] = resourceFilter?.value ?? [];
      const items = tickets.filter(t =>
        (!queueFilter || t.queueID === queueFilter.value) &&
        resourceIDs.includes(t.assignedResourceID) &&
        t.status !== 5
      );
      return ok({ items, pageDetails: { count: items.length } });
    }

    if (method === 'POST' && path.endsWith('/Tickets')) {
      const id = nextTicketId++;
      tickets.push({
        id,
        queueID: body.queueID,
        assignedResourceID: body.assignedResourceID,
        status: body.status ?? 1,
      });
      return ok({ itemId: id });
    }

    if (method === 'PATCH' && /\/Tickets\/\d+$/.test(path)) {
      const id = Number(path.split('/').pop());
      const row = tickets.find(t => t.id === id);
      if (row) {
        if (body.assignedResourceID !== undefined) row.assignedResourceID = body.assignedResourceID;
        if (body.queueID !== undefined) row.queueID = body.queueID;
      }
      return ok({ itemId: id });
    }

    return notFound();
  });

  return { calls, tickets, releaseGate };
}

function handler(): AutotaskToolHandler {
  return new AutotaskToolHandler(new AutotaskService(config, logger), logger);
}

function parseResult(toolResult: any): any {
  return JSON.parse(toolResult.content[0].text);
}

beforeEach(() => {
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const QUEUE = 29682901;

describe('autotask_assign_least_loaded_resource', () => {
  test('is registered in TOOL_DEFINITIONS and the tickets category', () => {
    const def = TOOL_DEFINITIONS.find(t => t.name === 'autotask_assign_least_loaded_resource');
    expect(def).toBeDefined();
    expect((def!.inputSchema.properties as any).queueID).toMatchObject({ type: 'number' });
    expect(TOOL_CATEGORIES.tickets.tools).toContain('autotask_assign_least_loaded_resource');
  });

  // TC1 / AC1
  test('spreads_concurrent_assignments_evenly_across_eligible_resources', async () => {
    const resources = [201, 202, 203, 204, 205];
    const resourceRoles: ResourceRoleRow[] = resources.map((r, i) => ({
      id: i + 1, resourceID: r, roleID: HELP_DESK_ROLE, queueID: QUEUE, isActive: true,
    }));
    const { tickets } = mockAutotask({ resourceRoles, tickets: [] });
    const h = handler();

    const calls = Array.from({ length: 10 }, () =>
      h.callTool('autotask_assign_least_loaded_resource', {
        queueID: QUEUE,
        createTicket: { companyID: 1, title: 'overflow ticket', description: 'd' },
      })
    );
    const results = await Promise.all(calls);

    for (const r of results) {
      expect(r.isError).toBeFalsy();
    }

    const countsByResource = new Map<number, number>(resources.map(r => [r, 0]));
    for (const t of tickets) {
      countsByResource.set(t.assignedResourceID, (countsByResource.get(t.assignedResourceID) ?? 0) + 1);
    }
    expect(tickets).toHaveLength(10);
    const spread = [...countsByResource.values()];
    expect(Math.max(...spread) - Math.min(...spread)).toBeLessThanOrEqual(1);
    expect(spread).toEqual([2, 2, 2, 2, 2]);
    // Every created ticket landed in the queue it was assigned from.
    expect(tickets.every(t => t.queueID === QUEUE)).toBe(true);
  });

  // TC2 / AC2
  test('assigns_all_tickets_to_the_sole_eligible_resource', async () => {
    const SOLO = 301;
    const resourceRoles: ResourceRoleRow[] = [
      { id: 1, resourceID: SOLO, roleID: HELP_DESK_ROLE, queueID: QUEUE, isActive: true },
    ];
    const { tickets } = mockAutotask({ resourceRoles, tickets: [] });
    const h = handler();

    for (let i = 0; i < 5; i++) {
      const result = await h.callTool('autotask_assign_least_loaded_resource', {
        queueID: QUEUE,
        createTicket: { companyID: 1, title: `t${i}`, description: 'd' },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).data.assignedResourceID).toBe(SOLO);
    }

    expect(tickets).toHaveLength(5);
    expect(tickets.every(t => t.assignedResourceID === SOLO)).toBe(true);
  });

  // TC3 / AC3
  test('picks_the_resource_with_the_fewest_open_tickets', async () => {
    const [HEAVY, IDLE, MEDIUM] = [401, 402, 403];
    const resourceRoles: ResourceRoleRow[] = [HEAVY, IDLE, MEDIUM].map((r, i) => ({
      id: i + 1, resourceID: r, roleID: HELP_DESK_ROLE, queueID: QUEUE, isActive: true,
    }));
    const existingTickets: TicketRow[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: 1000 + i, queueID: QUEUE, assignedResourceID: HEAVY, status: 1 })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: 2000 + i, queueID: QUEUE, assignedResourceID: MEDIUM, status: 1 })),
    ];
    const { tickets } = mockAutotask({ resourceRoles, tickets: existingTickets });
    const h = handler();

    const result = await h.callTool('autotask_assign_least_loaded_resource', {
      queueID: QUEUE,
      createTicket: { companyID: 1, title: 'new', description: 'd' },
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result).data;
    expect(data.assignedResourceID).toBe(IDLE);
    const considered = new Map(data.consideredResources.map((c: any) => [c.resourceID, c.openTicketCount]));
    expect(considered.get(HEAVY)).toBe(5);
    expect(considered.get(IDLE)).toBe(0);
    expect(considered.get(MEDIUM)).toBe(3);
    expect(tickets.filter(t => t.assignedResourceID === IDLE)).toHaveLength(1);
  });

  // TC4 / AC4
  test('serializes_overlapping_calls_for_the_same_queue', async () => {
    const [R1, R2] = [501, 502];
    const resourceRoles: ResourceRoleRow[] = [R1, R2].map((r, i) => ({
      id: i + 1, resourceID: r, roleID: HELP_DESK_ROLE, queueID: QUEUE, isActive: true,
    }));
    // Gate the FIRST Tickets/query (call A's count read) so call B cannot
    // possibly race ahead of it by accident — only the lock can make B wait.
    const { calls, tickets, releaseGate } = mockAutotask({
      resourceRoles,
      tickets: [],
      gateTicketsQueryCall: 1,
    });
    const h = handler();

    const callA = h.callTool('autotask_assign_least_loaded_resource', {
      queueID: QUEUE,
      createTicket: { companyID: 1, title: 'A', description: 'd' },
    });
    // Issued synchronously right after A, before anything is awaited — this
    // is the scenario AC4 describes ("issued so their internal counting
    // steps would overlap without serialization").
    const callB = h.callTool('autotask_assign_least_loaded_resource', {
      queueID: QUEUE,
      createTicket: { companyID: 1, title: 'B', description: 'd' },
    });

    // Let every already-resolved microtask drain. Call A should be stalled
    // inside its gated Tickets/query; call B's fn must not have started at
    // all yet, because the lock only invokes it after A's fn settles.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const callsBeforeRelease = calls.length;
    expect(tickets).toHaveLength(0); // neither call has written yet

    releaseGate();
    const [resultA, resultB] = await Promise.all([callA, callB]);

    expect(resultA.isError).toBeFalsy();
    expect(resultB.isError).toBeFalsy();
    expect(tickets).toHaveLength(2);

    const resourceA = parseResult(resultA).data.assignedResourceID;
    const resourceB = parseResult(resultB).data.assignedResourceID;
    // B's decision must reflect A's result, not a stale snapshot: both start
    // at count 0, so A picks the lowest id (R1); B must then see R1 already
    // at 1 and pick R2 — never the same resource as A.
    expect(resourceA).toBe(R1);
    expect(resourceB).toBe(R2);

    // And B genuinely waited: more fetch calls happened after the release
    // than had happened while A was gated (B's own ResourceRoles/Tickets
    // calls all occur after A's call count query unblocks).
    expect(calls.length).toBeGreaterThan(callsBeforeRelease);
  });

  // TC5 / AC5
  test('rejects_assignment_when_no_eligible_resource_exists', async () => {
    const EMPTY_QUEUE = 999999;
    const { calls } = mockAutotask({ resourceRoles: [], tickets: [] });
    const h = handler();

    const result = await h.callTool('autotask_assign_least_loaded_resource', {
      queueID: EMPTY_QUEUE,
      ticketID: 777,
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain(String(EMPTY_QUEUE));
    expect(parsed.error).toMatch(/no active eligible/i);
    expect(new NoEligibleResourceError(EMPTY_QUEUE).message).toBe(parsed.error);

    // Neither a create nor an update was ever attempted.
    expect(calls.some(c => c.method === 'POST' && c.path.endsWith('/Tickets'))).toBe(false);
    expect(calls.some(c => c.method === 'PATCH' && c.path.endsWith('/Tickets/777'))).toBe(false);
  });

  // Extra, dev-sourced coverage (not tied to a numbered AC): the contract
  // requires exactly one of ticketID/createTicket — this guards against a
  // caller silently getting ticketID's behavior when they meant to create.
  test('rejects a call that gives both or neither of ticketID/createTicket', async () => {
    const resourceRoles: ResourceRoleRow[] = [
      { id: 1, resourceID: 601, roleID: HELP_DESK_ROLE, queueID: QUEUE, isActive: true },
    ];
    mockAutotask({ resourceRoles, tickets: [] });
    const h = handler();

    const neither = await h.callTool('autotask_assign_least_loaded_resource', { queueID: QUEUE });
    expect(neither.isError).toBe(true);

    const both = await h.callTool('autotask_assign_least_loaded_resource', {
      queueID: QUEUE,
      ticketID: 1,
      createTicket: { companyID: 1, title: 't', description: 'd' },
    });
    expect(both.isError).toBe(true);
  });
});
