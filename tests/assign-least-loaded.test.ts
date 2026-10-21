// autotask_assign_least_loaded_resource (PRD-20620, r2 contract).
//
// Round 1's reported defect: when the agent processes several tickets "at
// the same time," ticket assignment was entirely the LLM's own per-call
// guess with no shared state, so concurrent assignments collapsed onto one
// technician. Round 1's fix queried Autotask for queue membership itself and
// counted a fixed "not complete" status.
//
// r2 (requirement change, Lucas Chen 2026-10-21, see docs/tickets/PRD-20620-r2.md):
// the caller now supplies the candidate `technicians` list directly (this
// tool no longer queries Autotask for queue membership), and "load" is
// counted against a caller-supplied `status` + optional `queueIDs` filter
// instead of a fixed "not complete" assumption. The deterministic pick
// (fewest matching tickets, ties by lowest resourceID) and the per-call lock
// (src/utils/queue-lock.ts) carry over unchanged in mechanism, keyed on the
// new status/queueIDs/technicians combination instead of queueID alone.
//
// Mocking strategy: a real AutotaskService + AutotaskToolHandler against a
// routed `fetch` mock (same shape as tests/resource-roles.test.ts), backed by
// mutable ticket state so a ticket created mid-test is counted by the NEXT
// count query — that state mutation is exactly what AC4 depends on. No
// ResourceRoles/Roles mocking is needed any more: r2 removes this tool's only
// Autotask-query step (eligibility discovery) and its only role-resolution
// call (the caller already supplies roleID per technician).

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { AutotaskToolHandler, NoCandidateTechniciansError } from '../src/handlers/tool.handler';
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

interface TicketRow {
  id: number;
  queueID: number;
  assignedResourceID: number;
  status: number;
}

/**
 * A `fetch` mock that answers Tickets queries/creates/updates by URL suffix,
 * backed by mutable state so a ticket created mid-test is counted by the
 * NEXT count query. `gate`, when given, defers the resolution of the N-th
 * (1-indexed) `Tickets/query` call until it resolves, to force a controlled
 * overlap window for the serialization test.
 */
function mockAutotask(opts: {
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

    if (method === 'POST' && path.endsWith('/Tickets/query')) {
      ticketsQueryCount += 1;
      if (opts.gateTicketsQueryCall === ticketsQueryCount) {
        await gatePromise;
      }
      const filters: any[] = body.filter || [];
      const statusFilter = findFilter(filters, 'status');
      const queueFilter = findFilter(filters, 'queueID');
      const resourceFilter = findFilter(filters, 'assignedResourceID');
      const resourceIDs: number[] = resourceFilter?.value ?? [];
      const queueIDs: number[] | undefined = queueFilter?.value;
      const items = tickets.filter(t =>
        (!statusFilter || t.status === statusFilter.value) &&
        (!queueIDs || queueIDs.includes(t.queueID)) &&
        resourceIDs.includes(t.assignedResourceID)
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

    // Collection-level PATCH /Tickets with { id, ...fields } is the real
    // Autotask update pattern (src/services/autotask-http.ts's `update()`
    // comment) — there is no PATCH /Tickets/{id} route.
    if (method === 'PATCH' && path.endsWith('/Tickets')) {
      const id = body.id;
      const row = tickets.find(t => t.id === id);
      if (row) {
        if (body.assignedResourceID !== undefined) row.assignedResourceID = body.assignedResourceID;
        if (body.queueID !== undefined) row.queueID = body.queueID;
      }
      return ok(undefined);
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
const STATUS = 1; // "open"-equivalent stand-in; this tool no longer assumes any fixed meaning for it.

function tech(resourceID: number, roleID = 501): { resourceID: number; roleID: number } {
  return { resourceID, roleID };
}

describe('autotask_assign_least_loaded_resource', () => {
  test('is registered in TOOL_DEFINITIONS and the tickets category', () => {
    const def = TOOL_DEFINITIONS.find(t => t.name === 'autotask_assign_least_loaded_resource');
    expect(def).toBeDefined();
    expect((def!.inputSchema.properties as any).technicians).toMatchObject({ type: 'array' });
    expect((def!.inputSchema.properties as any).status).toMatchObject({ type: 'number' });
    expect((def!.inputSchema.properties as any).queueIDs).toMatchObject({ type: 'array' });
    expect(def!.inputSchema.required).toEqual(['status', 'technicians']);
    expect(TOOL_CATEGORIES.tickets.tools).toContain('autotask_assign_least_loaded_resource');
  });

  // TC1 / AC1
  test('spreads_concurrent_assignments_evenly_across_listed_technicians', async () => {
    const resources = [201, 202, 203, 204, 205];
    const technicians = resources.map(r => tech(r));
    const { tickets } = mockAutotask({ tickets: [] });
    const h = handler();

    const calls = Array.from({ length: 10 }, () =>
      h.callTool('autotask_assign_least_loaded_resource', {
        status: STATUS,
        queueIDs: [QUEUE],
        technicians,
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
    // Every created ticket landed in the single queue given via queueIDs.
    expect(tickets.every(t => t.queueID === QUEUE)).toBe(true);
  });

  // TC2 / AC2
  test('assigns_all_tickets_to_the_sole_listed_technician', async () => {
    const SOLO = 301;
    const technicians = [tech(SOLO)];
    const { tickets } = mockAutotask({ tickets: [] });
    const h = handler();

    for (let i = 0; i < 5; i++) {
      const result = await h.callTool('autotask_assign_least_loaded_resource', {
        status: STATUS,
        queueIDs: [QUEUE],
        technicians,
        createTicket: { companyID: 1, title: `t${i}`, description: 'd' },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).data.assignedResourceID).toBe(SOLO);
    }

    expect(tickets).toHaveLength(5);
    expect(tickets.every(t => t.assignedResourceID === SOLO)).toBe(true);
  });

  // TC3 / AC3
  test('picks_the_listed_technician_with_the_fewest_matching_tickets', async () => {
    const [HEAVY, IDLE, MEDIUM] = [401, 402, 403];
    const technicians = [HEAVY, IDLE, MEDIUM].map(r => tech(r));
    const existingTickets: TicketRow[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: 1000 + i, queueID: QUEUE, assignedResourceID: HEAVY, status: STATUS })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: 2000 + i, queueID: QUEUE, assignedResourceID: MEDIUM, status: STATUS })),
    ];
    const { tickets } = mockAutotask({ tickets: existingTickets });
    const h = handler();

    const result = await h.callTool('autotask_assign_least_loaded_resource', {
      status: STATUS,
      queueIDs: [QUEUE],
      technicians,
      createTicket: { companyID: 1, title: 'new', description: 'd' },
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result).data;
    expect(data.assignedResourceID).toBe(IDLE);
    const considered = new Map(data.consideredTechnicians.map((c: any) => [c.resourceID, c.matchingTicketCount]));
    expect(considered.get(HEAVY)).toBe(5);
    expect(considered.get(IDLE)).toBe(0);
    expect(considered.get(MEDIUM)).toBe(3);
    expect(tickets.filter(t => t.assignedResourceID === IDLE)).toHaveLength(1);
  });

  // TC4 / AC4
  test('serializes_overlapping_calls_for_the_same_lock_key', async () => {
    const [R1, R2] = [501, 502];
    const technicians = [R1, R2].map(r => tech(r));
    // Gate the FIRST Tickets/query (call A's count read) so call B cannot
    // possibly race ahead of it by accident — only the lock can make B wait.
    const { calls, tickets, releaseGate } = mockAutotask({
      tickets: [],
      gateTicketsQueryCall: 1,
    });
    const h = handler();

    const callA = h.callTool('autotask_assign_least_loaded_resource', {
      status: STATUS,
      queueIDs: [QUEUE],
      technicians,
      createTicket: { companyID: 1, title: 'A', description: 'd' },
    });
    // Issued synchronously right after A, before anything is awaited — this
    // is the scenario AC4 describes ("issued so their internal counting
    // steps would overlap without serialization").
    const callB = h.callTool('autotask_assign_least_loaded_resource', {
      status: STATUS,
      queueIDs: [QUEUE],
      technicians,
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
    // than had happened while A was gated.
    expect(calls.length).toBeGreaterThan(callsBeforeRelease);
  });

  // TC5 / AC5
  test('rejects_assignment_when_no_candidate_technicians_given', async () => {
    const { calls } = mockAutotask({ tickets: [] });
    const h = handler();

    const missing = await h.callTool('autotask_assign_least_loaded_resource', {
      status: STATUS,
      ticketID: 777,
    });
    expect(missing.isError).toBe(true);
    const parsedMissing = JSON.parse(missing.content[0].text);
    expect(parsedMissing.error).toBe(new NoCandidateTechniciansError().message);

    const empty = await h.callTool('autotask_assign_least_loaded_resource', {
      status: STATUS,
      technicians: [],
      ticketID: 777,
    });
    expect(empty.isError).toBe(true);
    const parsedEmpty = JSON.parse(empty.content[0].text);
    expect(parsedEmpty.error).toBe(new NoCandidateTechniciansError().message);

    // Neither a create nor an update was ever attempted.
    expect(calls.some(c => c.method === 'POST' && c.path.endsWith('/Tickets'))).toBe(false);
    expect(calls.some(c => c.method === 'PATCH' && c.path.endsWith('/Tickets/777'))).toBe(false);
  });

  // TC6 / AC6
  test('only_counts_tickets_matching_the_status_and_queue_filter', async () => {
    const [A, B] = [601, 602];
    const technicians = [A, B].map(r => tech(r));
    const existingTickets: TicketRow[] = [
      // A has 10 total tickets for this queue, but only 2 match STATUS.
      ...Array.from({ length: 2 }, (_, i) => ({ id: 3000 + i, queueID: QUEUE, assignedResourceID: A, status: STATUS })),
      ...Array.from({ length: 8 }, (_, i) => ({ id: 3100 + i, queueID: QUEUE, assignedResourceID: A, status: 5 /* Complete, not STATUS */ })),
      // Also one matching-status ticket in a different queue, which the
      // queueIDs filter must exclude from A's count.
      { id: 3200, queueID: QUEUE + 1, assignedResourceID: A, status: STATUS },
      // B has 1 matching ticket.
      { id: 3300, queueID: QUEUE, assignedResourceID: B, status: STATUS },
      // The ticket this call will reassign — must pre-exist for the PATCH
      // mock to have a row to update. Pre-assigned to neither A nor B, so it
      // doesn't contaminate either technician's matching-ticket count above.
      { id: 9999, queueID: QUEUE, assignedResourceID: 999999, status: STATUS },
    ];
    const { tickets } = mockAutotask({ tickets: existingTickets });
    const h = handler();

    const result = await h.callTool('autotask_assign_least_loaded_resource', {
      status: STATUS,
      queueIDs: [QUEUE],
      technicians,
      ticketID: 9999,
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result).data;
    const considered = new Map(data.consideredTechnicians.map((c: any) => [c.resourceID, c.matchingTicketCount]));
    expect(considered.get(A)).toBe(2); // not 10, not 3 -- only the in-queue, matching-status tickets
    expect(considered.get(B)).toBe(1);
    expect(data.assignedResourceID).toBe(B); // B has the fewer matching count (1 < 2)
    expect(tickets.find(t => t.id === 9999)?.assignedResourceID).toBe(B);
  });

  // TC7 / AC7
  test('returns_a_fully_structured_result', async () => {
    const [R1, R2] = [701, 702];
    const technicians = [tech(R1, 9001), tech(R2, 9002)];
    mockAutotask({ tickets: [] });
    const h = handler();

    const result = await h.callTool('autotask_assign_least_loaded_resource', {
      status: STATUS,
      queueIDs: [QUEUE],
      technicians,
      createTicket: { companyID: 1, title: 'structured', description: 'd' },
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result).data;
    expect(typeof data.ticketID).toBe('number');
    expect(data.assignedResourceID).toBe(R1); // lowest id, both start at 0
    expect(data.assignedResourceRoleID).toBe(9001);
    expect(data.appliedFilter).toEqual({ status: STATUS, queueIDs: [QUEUE] });
    expect(data.consideredTechnicians).toEqual([
      { resourceID: R1, roleID: 9001, matchingTicketCount: 0 },
      { resourceID: R2, roleID: 9002, matchingTicketCount: 0 },
    ]);
  });

  // TC8 / AC8
  test('requires_exactly_one_queue_id_when_creating_a_ticket', async () => {
    mockAutotask({ tickets: [] });
    const h = handler();
    const technicians = [tech(801)];

    const zeroQueues = await h.callTool('autotask_assign_least_loaded_resource', {
      status: STATUS,
      technicians,
      createTicket: { companyID: 1, title: 't', description: 'd' },
    });
    expect(zeroQueues.isError).toBe(true);

    const twoQueues = await h.callTool('autotask_assign_least_loaded_resource', {
      status: STATUS,
      queueIDs: [QUEUE, QUEUE + 1],
      technicians,
      createTicket: { companyID: 1, title: 't', description: 'd' },
    });
    expect(twoQueues.isError).toBe(true);

    // A reassignment (ticketID, not createTicket) is unaffected by this rule.
    const reassign = await h.callTool('autotask_assign_least_loaded_resource', {
      status: STATUS,
      technicians,
      ticketID: 123,
    });
    expect(reassign.isError).toBeFalsy();
  });

  // Extra, dev-sourced coverage (not tied to a numbered AC): the contract
  // requires exactly one of ticketID/createTicket — this guards against a
  // caller silently getting ticketID's behavior when they meant to create.
  // Unmodified in substance from round 1 (TC-DEV1); rewritten for the new
  // required technicians/status fields since the old call shape would now
  // fail NoCandidateTechniciansError validation before reaching this check.
  test('rejects a call that gives both or neither of ticketID/createTicket', async () => {
    mockAutotask({ tickets: [] });
    const h = handler();
    const technicians = [tech(901)];

    const neither = await h.callTool('autotask_assign_least_loaded_resource', { status: STATUS, technicians });
    expect(neither.isError).toBe(true);

    const both = await h.callTool('autotask_assign_least_loaded_resource', {
      status: STATUS,
      technicians,
      queueIDs: [QUEUE],
      ticketID: 1,
      createTicket: { companyID: 1, title: 't', description: 'd' },
    });
    expect(both.isError).toBe(true);
  });
});
