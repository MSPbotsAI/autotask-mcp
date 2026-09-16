// autotask_update_ticket could not move a ticket between queues: queueID was
// already in TICKET_WRITABLE_FIELDS (so buildTicketPayload would have passed it
// through) but was never advertised on the update tool's schema, so no caller
// ever sent it. The visible symptom was the reassignment path failing with
// HTTP 500 "A Service Desk Queue cannot be found for the assignedResourceID
// supplied. You cannot assign a Service Desk Ticket to a Resource that is not
// assigned to at least one Service Desk Queue." — the caller could name the
// resource but had no way to put the ticket in a queue that resource serves.
// (MSPbots PRD-19019, 13 of 20 observed production update failures, 2026-09-16.)

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { AutotaskToolHandler, TICKET_WRITABLE_FIELDS } from '../src/handlers/tool.handler';
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

function mockFetchOk(body: unknown): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function firstRequestBody(fetchMock: jest.SpyInstance): any {
  return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
}

beforeEach(() => {
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('autotask_update_ticket queueID', () => {
  test('is advertised on the tool, as it is on autotask_create_ticket', () => {
    const create = TOOL_DEFINITIONS.find(t => t.name === 'autotask_create_ticket');
    const update = TOOL_DEFINITIONS.find(t => t.name === 'autotask_update_ticket');
    expect((create!.inputSchema.properties as any).queueID).toMatchObject({ type: 'number' });
    expect((update!.inputSchema.properties as any).queueID).toMatchObject({ type: 'number' });
  });

  test('every field the update tool advertises is actually writable', () => {
    const update = TOOL_DEFINITIONS.find(t => t.name === 'autotask_update_ticket');
    const advertised = Object.keys(update!.inputSchema.properties as any)
      // ticketId addresses the record, the *Name helpers resolve to an id.
      .filter(f => f !== 'ticketId' && !f.endsWith('Name'));

    // Anything advertised but not writable is silently dropped by
    // buildTicketPayload, which is how assignedResourceRoleID used to go missing.
    expect(advertised).toEqual(expect.arrayContaining(['queueID']));
    for (const field of advertised) {
      expect(TICKET_WRITABLE_FIELDS).toContain(field);
    }
  });

  // Note: callTool does not filter arguments against the advertised schema, so
  // this one passes even with queueID missing from the schema — the two schema
  // assertions above are what actually guard the regression. It is kept to pin
  // the other half of the contract: that queueID survives buildTicketPayload
  // and lands in the PATCH body under the name Autotask expects.
  test('reaches the PATCH /Tickets payload under the name Autotask expects', async () => {
    const fetchMock = mockFetchOk({ itemId: 13896 });
    const service = new AutotaskService(config, logger);
    const handler = new AutotaskToolHandler(service, logger);

    const result = await handler.callTool('autotask_update_ticket', {
      ticketId: 13896,
      queueID: 8,
    });

    expect(result.isError).toBeFalsy();
    const body = firstRequestBody(fetchMock);
    expect(body.id).toBe(13896);
    expect(body.queueID).toBe(8);
  });

  test('is optional: a call without it sends no queueID key', async () => {
    const fetchMock = mockFetchOk({ itemId: 13896 });
    const service = new AutotaskService(config, logger);
    const handler = new AutotaskToolHandler(service, logger);

    await handler.callTool('autotask_update_ticket', { ticketId: 13896, title: 't' });

    expect(firstRequestBody(fetchMock)).not.toHaveProperty('queueID');
  });
});
