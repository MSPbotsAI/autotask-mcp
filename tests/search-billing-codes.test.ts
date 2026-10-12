// A ticket's "Work Type" is billingCodeID, a reference to the BillingCodes
// entity — not a picklist — so autotask_get_field_info returns nothing for it
// and no tool could list the valid ids. Callers creating tickets were left
// guessing. (PRD-20314, 2026-10-12.)

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
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

type Route = (body: any) => unknown;

function mockAutotask(routes: Record<string, Route>): { calls: Array<{ path: string; method: string; body: any }> } {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any, init: any) => {
    const path = String(url).replace(/^.*ATServicesRest\/?(v1\.0)?/, '');
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, method: init?.method ?? 'GET', body });
    const key = Object.keys(routes).find(k => path.endsWith(k));
    if (!key) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => `no route for ${path}` } as unknown as Response;
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(routes[key](body)) } as unknown as Response;
  });
  return { calls };
}

const billingCodes = {
  '/BillingCodes/query': () => ({ items: [
    { id: 29682801, name: 'IT:Remote (Billable)', useType: 1, isActive: true },
    { id: 29682802, name: 'IT:Remote (Non-Billable)', useType: 1, isActive: true },
  ], pageDetails: { count: 2 } }),
  '/BillingCodes/entityInformation/fields': () => ({ fields: [
    { name: 'useType', dataType: 'integer', isPickList: true, picklistValues: [
      { value: '1', label: 'Regular Time', isActive: true },
      { value: '3', label: 'Internal Time', isActive: true },
    ] },
  ] }),
};

function handler(): AutotaskToolHandler {
  return new AutotaskToolHandler(new AutotaskService(config, logger), logger);
}

beforeEach(() => {
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('autotask_search_billing_codes', () => {
  test('is advertised, read-only, and filed under utility', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'autotask_search_billing_codes');
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(TOOL_CATEGORIES.utility.tools).toContain('autotask_search_billing_codes');
  });

  test('ticket billingCodeID points at it on create and update', () => {
    for (const name of ['autotask_create_ticket', 'autotask_update_ticket']) {
      const tool = TOOL_DEFINITIONS.find(t => t.name === name)!;
      const prop = (tool.inputSchema.properties as any).billingCodeID;
      expect(prop).toBeDefined();
      expect(prop.description).toContain('autotask_search_billing_codes');
    }
  });

  test('lists active codes with their use type label', async () => {
    const { calls } = mockAutotask(billingCodes);

    const result = await handler().callTool('autotask_search_billing_codes', {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text as string;
    expect(text).toContain('IT:Remote (Billable)');
    expect(text).toContain('29682801');
    expect(text).toContain('Regular Time');

    const query = calls.find(c => c.path.endsWith('/BillingCodes/query'))!.body;
    expect(query.filter).toEqual([{ op: 'eq', field: 'isActive', value: true }]);
  });

  test('passes name, useType and includeInactive through as filters', async () => {
    const { calls } = mockAutotask(billingCodes);

    await handler().callTool('autotask_search_billing_codes', { name: 'Remote', useType: 1, includeInactive: true });

    const query = calls.find(c => c.path.endsWith('/BillingCodes/query'))!.body;
    expect(query.filter).toEqual([
      { op: 'contains', field: 'name', value: 'Remote' },
      { op: 'eq', field: 'useType', value: 1 },
    ]);
  });

  test('never sends an empty filter', async () => {
    const { calls } = mockAutotask(billingCodes);

    await new AutotaskService(config, logger).searchBillingCodes({ includeInactive: true });

    const query = calls.find(c => c.path.endsWith('/BillingCodes/query'))!.body;
    expect(query.filter.length).toBeGreaterThan(0);
  });
});
