// PRD-20217 follow-up: Autotask requires isActive on a contact create and
// answers HTTP 500 "Missing Required Field: isActive" when it is missing.
// LLM callers routinely omit it, so AutotaskService.createContact() now
// defaults it to 1 (active) on both the POST /Contacts route and the
// POST /Companies/{companyID}/Contacts child-route fallback. These tests
// assert on the request body actually sent, not on the return value.

import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
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
    // Pre-set apiUrl so baseUrl() resolves without a zone-info network round-trip.
    apiUrl: 'https://webservices2.autotask.net/ATServicesRest/',
  },
};

interface MockResponseSpec {
  status: number;
  body?: any;
  text?: string;
}

function res(spec: MockResponseSpec): Response {
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    headers: { get: () => null },
    text: async () =>
      spec.text !== undefined ? spec.text : spec.body !== undefined ? JSON.stringify(spec.body) : '',
  } as unknown as Response;
}

/**
 * Route-table fetch mock: match on method + URL pattern. Unmatched requests
 * return a distinctive 599 so a failing test names the unexpected call.
 */
function mockFetchRoutes(
  routes: Array<{ method: string; path: RegExp; response: MockResponseSpec }>
): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    const init = (args[1] || {}) as RequestInit;
    const match = routes.find(r => r.method === (init.method || 'GET') && r.path.test(url));
    if (!match) {
      return Promise.resolve(res({ status: 599, text: `unexpected request: ${init.method} ${url}` }));
    }
    return Promise.resolve(res(match.response));
  });
}

function sentBody(fetchMock: jest.SpyInstance, call: number): Record<string, any> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

const HTML_404 = {
  status: 404,
  text: '<html><head><title>404 - File or directory not found.</title></head></html>',
};

beforeEach(() => {
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AutotaskService.createContact() isActive default (PRD-20217)', () => {
  test('sends isActive: 1 when the caller omits it', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'POST', path: /v1\.0\/Contacts$/, response: { status: 200, body: { itemId: 555 } } },
    ]);

    const service = new AutotaskService(config, logger);
    await expect(
      service.createContact({ companyID: 29683561, firstName: 'Taylor', lastName: 'QATest31' })
    ).resolves.toBe(555);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchMock, 0)).toEqual({
      companyID: 29683561,
      firstName: 'Taylor',
      lastName: 'QATest31',
      isActive: 1,
    });
  });

  test('keeps an explicit isActive: 0 (caller asked for an inactive contact)', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'POST', path: /v1\.0\/Contacts$/, response: { status: 200, body: { itemId: 556 } } },
    ]);

    const service = new AutotaskService(config, logger);
    await service.createContact({ companyID: 1, firstName: 'A', lastName: 'B', isActive: 0 });

    expect(sentBody(fetchMock, 0).isActive).toBe(0);
  });

  test('keeps an explicit isActive: 1 unchanged', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'POST', path: /v1\.0\/Contacts$/, response: { status: 200, body: { itemId: 557 } } },
    ]);

    const service = new AutotaskService(config, logger);
    await service.createContact({ companyID: 1, firstName: 'A', lastName: 'B', isActive: 1 });

    expect(sentBody(fetchMock, 0).isActive).toBe(1);
  });

  test('the 404 child-route fallback also sends isActive: 1', async () => {
    const fetchMock = mockFetchRoutes([
      { method: 'POST', path: /v1\.0\/Contacts$/, response: HTML_404 },
      { method: 'POST', path: /\/Companies\/777\/Contacts$/, response: { status: 200, body: { itemId: 558 } } },
    ]);

    const service = new AutotaskService(config, logger);
    await expect(
      service.createContact({ companyID: 777, firstName: 'Jordan', lastName: 'QATest27' })
    ).resolves.toBe(558);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock, 0).isActive).toBe(1);
    expect(sentBody(fetchMock, 1)).toMatchObject({ companyID: 777, isActive: 1 });
  });

  test('does not mutate the caller-supplied object', async () => {
    mockFetchRoutes([
      { method: 'POST', path: /v1\.0\/Contacts$/, response: { status: 200, body: { itemId: 559 } } },
    ]);

    const input = { companyID: 1, firstName: 'A', lastName: 'B' };
    const service = new AutotaskService(config, logger);
    await service.createContact(input);

    expect(input).toEqual({ companyID: 1, firstName: 'A', lastName: 'B' });
  });
});

describe('autotask_create_contact tool definition (PRD-20217)', () => {
  test('advertises isActive with default 1 so the model sees it', () => {
    const def = TOOL_DEFINITIONS.find(t => t.name === 'autotask_create_contact');
    expect(def).toBeDefined();
    const isActive = (def!.inputSchema as any).properties.isActive;
    expect(isActive).toMatchObject({ type: 'number', default: 1 });
    expect(isActive.description).toMatch(/defaults to 1/i);
    // Still optional for callers: the service fills it in.
    expect((def!.inputSchema as any).required).toEqual(['companyID', 'firstName', 'lastName']);
  });
});
