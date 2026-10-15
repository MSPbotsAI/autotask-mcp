// PRD-20317: autotask_search_contacts can, on request, return each matched
// contact's Autotask custom fields (userDefinedFields) in the same response,
// eliminating the need for a separate follow-up lookup. Default behavior for
// every existing caller is unchanged.
//
// Covers docs/tickets/PRD-20317.ac.json TC1-TC6 (AC1-AC6).

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API')),
  },
}));

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

// Fixture contacts. `userDefinedFields` here models what Autotask itself would
// store; the mock /Contacts/query route below only echoes it back when the
// request's IncludeFields asked for it -- same gate the real API applies.
const CONTACTS = [
  {
    id: 1,
    companyID: 100,
    firstName: 'Jane',
    lastName: 'Doe',
    emailAddress: 'jane@example.com',
    userDefinedFields: [{ name: 'PreferredContactMethod', value: 'Email' }],
  },
  {
    id: 2,
    companyID: 100,
    firstName: 'John',
    lastName: 'Smith',
    emailAddress: 'john@example.com',
    userDefinedFields: [],
  },
  {
    id: 3,
    companyID: 200,
    firstName: 'Alice',
    lastName: 'Wong',
    emailAddress: 'alice@example.com',
    userDefinedFields: [{ name: 'Foo', value: 'Bar' }],
  },
];

function mockAutotaskContacts(): { calls: Array<{ path: string; method: string; body: any }> } {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any, init: any) => {
    const path = String(url).replace(/^.*ATServicesRest\/?(v1\.0)?/, '');
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, method: init?.method ?? 'GET', body });

    if (!path.endsWith('/Contacts/query')) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => `no route for ${path}` } as unknown as Response;
    }

    const filter: any[] = body?.filter ?? [];
    const companyEq = filter.find((f: any) => f.op === 'eq' && f.field === 'companyID');
    let items = companyEq ? CONTACTS.filter((c) => c.companyID === companyEq.value) : CONTACTS.slice();

    // searchTerm support, mirroring the real 'or' filter shape searchContacts() builds.
    const searchOr = filter.find((f: any) => f.op === 'or');
    if (searchOr) {
      const term = String(searchOr.items[0].value).toLowerCase();
      items = items.filter(
        (c) =>
          c.firstName.toLowerCase().includes(term) ||
          c.lastName.toLowerCase().includes(term) ||
          c.emailAddress.toLowerCase().includes(term)
      );
    }

    const includeUDF = Array.isArray(body?.IncludeFields) && body.IncludeFields.includes('userDefinedFields');
    const outItems = items.map((c) => {
      if (includeUDF) return c;
      const { userDefinedFields, ...rest } = c;
      return rest;
    });

    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ items: outItems, pageDetails: { count: outItems.length } }),
    } as unknown as Response;
  });
  return { calls };
}

function handler(): AutotaskToolHandler {
  return new AutotaskToolHandler(new AutotaskService(config, logger), logger);
}

beforeEach(() => {
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('autotask_search_contacts - includeUserDefinedFields (PRD-20317)', () => {
  // TC1 / AC1
  test('default-off: no userDefinedFields in response, and Autotask request carries no IncludeFields', async () => {
    const { calls } = mockAutotaskContacts();

    const result = await handler().callTool('autotask_search_contacts', { companyID: 100 });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content[0] as any).text as string);
    for (const item of body.items) {
      expect(item).not.toHaveProperty('userDefinedFields');
    }

    const query = calls.find((c) => c.path.endsWith('/Contacts/query'))!.body;
    expect(query.IncludeFields).toBeUndefined();
  });

  // TC1 / AC1 (explicit false behaves the same as omitted)
  test('explicit false behaves the same as omitted', async () => {
    mockAutotaskContacts();

    const result = await handler().callTool('autotask_search_contacts', {
      companyID: 100,
      includeUserDefinedFields: false,
    });

    const body = JSON.parse((result.content[0] as any).text as string);
    for (const item of body.items) {
      expect(item).not.toHaveProperty('userDefinedFields');
    }
  });

  // TC2 / AC2
  test('opt-in: returns the actual userDefinedFields for a contact that has them', async () => {
    mockAutotaskContacts();

    const result = await handler().callTool('autotask_search_contacts', {
      companyID: 100,
      includeUserDefinedFields: true,
    });

    const body = JSON.parse((result.content[0] as any).text as string);
    const jane = body.items.find((i: any) => i.id === 1);
    expect(jane.userDefinedFields).toEqual([{ name: 'PreferredContactMethod', value: 'Email' }]);
  });

  // TC3 / AC3
  test('opt-in: does not fabricate userDefinedFields for a contact with none set', async () => {
    mockAutotaskContacts();

    const result = await handler().callTool('autotask_search_contacts', {
      companyID: 100,
      includeUserDefinedFields: true,
    });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content[0] as any).text as string);
    const john = body.items.find((i: any) => i.id === 2);
    // Key absent or an empty array are both acceptable -- just no fabricated data.
    if ('userDefinedFields' in john) {
      expect(john.userDefinedFields).toEqual([]);
    }
  });

  // TC4 / AC4
  test('opt-in: every normally-returned field is still present and unchanged', async () => {
    mockAutotaskContacts();

    const result = await handler().callTool('autotask_search_contacts', {
      companyID: 100,
      includeUserDefinedFields: true,
    });

    const body = JSON.parse((result.content[0] as any).text as string);
    const jane = body.items.find((i: any) => i.id === 1);
    expect(jane).toMatchObject({
      id: 1,
      firstName: 'Jane',
      lastName: 'Doe',
      emailAddress: 'jane@example.com',
      companyID: 100,
    });
  });

  // TC5 / AC5 -- modified during dev (see docs/tickets/PRD-20317.md "Self-test"
  // for the full writeup). AC5's literal text ("returns the existing
  // empty-result shape ... without error") assumed a bare "Found 0 contacts"
  // message; the tool's *actual* existing behavior for zero matches is an
  // isError:true anti-hallucination guard (tool.handler.ts buildNotFoundMessage
  // -> errorToolResult, present since #225, unconditional on any search tool's
  // own args). That guard is uniform across all autotask_search_* tools and
  // fires before this ticket's includeUserDefinedFields branch is ever reached,
  // so it was already "today's" behavior, not something this change introduces.
  // What AC5 actually protects -- the flag not altering zero-match handling --
  // still holds; this asserts both halves of that explicitly.
  test('opt-in: zero matches hits the same pre-existing no-fabrication error as without the flag (no new error path, no crash)', async () => {
    mockAutotaskContacts();
    const withFlag = await handler().callTool('autotask_search_contacts', {
      searchTerm: 'nobody-matches-this',
      includeUserDefinedFields: true,
    });
    mockAutotaskContacts();
    const withoutFlag = await handler().callTool('autotask_search_contacts', {
      searchTerm: 'nobody-matches-this',
    });

    // Same error shape and same guard fires either way -- the only difference
    // is that the echoed "search criteria" in the message legitimately lists
    // includeUserDefinedFields as one of the args that was searched with,
    // which is correct, not a behavior change.
    expect(withFlag.isError).toBe(true);
    expect(withoutFlag.isError).toBe(true);
    const textWithFlag = (withFlag.content[0] as any).text as string;
    const textWithoutFlag = (withoutFlag.content[0] as any).text as string;
    expect(textWithFlag).toContain('do not guess or fabricate data');
    expect(textWithoutFlag).toContain('do not guess or fabricate data');
  });

  // TC6 / AC6
  test('opt-in: companyID filter is not relaxed -- no cross-company leak', async () => {
    const { calls } = mockAutotaskContacts();

    const result = await handler().callTool('autotask_search_contacts', {
      companyID: 100,
      includeUserDefinedFields: true,
    });

    const body = JSON.parse((result.content[0] as any).text as string);
    const ids = body.items.map((i: any) => i.id).sort();
    expect(ids).toEqual([1, 2]); // not 3 (companyID 200)
    expect(body.items.every((i: any) => i.companyID === 100)).toBe(true);

    const query = calls.find((c) => c.path.endsWith('/Contacts/query'))!.body;
    expect(query.filter).toEqual(expect.arrayContaining([{ op: 'eq', field: 'companyID', value: 100 }]));
  });

  // Regression guard (source: dev, not in the groomed AC ledger) -- the
  // compact-response call site at tool.handler.ts is shared by all 9
  // COMPACT_SEARCH_TOOLS; this asserts a sibling tool's output is provably
  // unaffected by the new extraFields wiring, rather than relying on absence
  // of failure in its own test file.
  test('does not affect other COMPACT_SEARCH_TOOLS (e.g. autotask_search_companies)', async () => {
    jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const path = String(url).replace(/^.*ATServicesRest\/?(v1\.0)?/, '');
      if (path.endsWith('/Companies/query')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ items: [{ id: 9, companyName: 'Acme' }], pageDetails: { count: 1 } }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'no route' } as unknown as Response;
    });

    const result = await handler().callTool('autotask_search_companies', {});
    const body = JSON.parse((result.content[0] as any).text as string);
    expect(body.items[0]).not.toHaveProperty('userDefinedFields');
  });
});
