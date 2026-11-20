import { describe, it, expect } from 'vitest';
import {
  classifyGraphEndpointFamily,
  isOneNoteBudgetFamily,
  ONENOTE_BUDGET_FAMILIES,
  formatSyncRunTelemetryLine,
  isValidSyncRunOutcome,
  deriveTelemetryUserKey,
  formatGraphTelemetryLine,
  isValidSyncRunId,
  readSyncRunId,
} from './graphTelemetry';

describe('classifyGraphEndpointFamily', () => {
  it('separates the OneNote families that spend the request budget', () => {
    expect(classifyGraphEndpointFamily('groups/c1/onenote/notebooks')).toBe('notebooks');
    expect(classifyGraphEndpointFamily('groups/c1/onenote/sectionGroups/sg1/sectionGroups')).toBe('section_groups');
    expect(classifyGraphEndpointFamily('groups/c1/onenote/sectionGroups/sg1/sections')).toBe('sections');
    expect(classifyGraphEndpointFamily('groups/c1/onenote/sections/s1/pages')).toBe('section_pages');
    expect(classifyGraphEndpointFamily('groups/c1/onenote/pages/p1/content')).toBe('page_content');
  });

  it('distinguishes page listing from page content', () => {
    // These two have very different costs and are the pair most worth telling apart.
    expect(classifyGraphEndpointFamily('me/onenote/sections/s1/pages')).toBe('section_pages');
    expect(classifyGraphEndpointFamily('me/onenote/pages/p1/content')).toBe('page_content');
  });

  it('labels identity, roster, mail and chat traffic', () => {
    expect(classifyGraphEndpointFamily('me')).toBe('identity');
    expect(classifyGraphEndpointFamily('me/memberOf')).toBe('identity');
    expect(classifyGraphEndpointFamily('users/u1')).toBe('identity');
    expect(classifyGraphEndpointFamily('education/classes/c1/members')).toBe('roster');
    expect(classifyGraphEndpointFamily('me/sendMail')).toBe('mail');
    expect(classifyGraphEndpointFamily('chats/ch1/messages')).toBe('chat');
  });

  it('ignores query strings and leading slashes', () => {
    expect(classifyGraphEndpointFamily('/groups/c1/onenote/sections/s1/pages?$select=id')).toBe('section_pages');
  });

  it('never returns an identifier as the label', () => {
    // The family is the whole privacy story for the path: no class or page ids.
    const family = classifyGraphEndpointFamily('groups/02bbcb8c-46d6-4727/onenote/sections/1-6e8ee459/pages');
    expect(family).toBe('section_pages');
    expect(family).not.toMatch(/02bbcb8c|6e8ee459/);
  });
});

describe('sync run id validation', () => {
  it('accepts a well-formed uuid', () => {
    expect(isValidSyncRunId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
  });

  it('rejects client-supplied junk rather than logging it', () => {
    // Unvalidated, this field would be arbitrary attacker-controlled log content
    // and unbounded cardinality.
    expect(isValidSyncRunId('not-a-uuid')).toBe(false);
    expect(isValidSyncRunId('"; DROP TABLE')).toBe(false);
    expect(isValidSyncRunId('x'.repeat(5000))).toBe(false);
    expect(isValidSyncRunId(undefined)).toBe(false);
    expect(isValidSyncRunId(42)).toBe(false);
  });

  it('omits an invalid header instead of failing the request', () => {
    expect(readSyncRunId('bogus')).toBeUndefined();
    expect(readSyncRunId(['3f2504e0-4f89-41d3-9a0c-0305e82c3301'])).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });
});

describe('deriveTelemetryUserKey', () => {
  const secret = 'test-session-secret';

  it('is stable for the same account', () => {
    const a = deriveTelemetryUserKey('account-1', secret);
    expect(a).toBe(deriveTelemetryUserKey('account-1', secret));
    expect(a).toHaveLength(12);
  });

  it('differs between accounts and between deployments', () => {
    expect(deriveTelemetryUserKey('account-1', secret)).not.toBe(deriveTelemetryUserKey('account-2', secret));
    expect(deriveTelemetryUserKey('account-1', secret)).not.toBe(deriveTelemetryUserKey('account-1', 'other-secret'));
  });

  it('never emits the account id itself', () => {
    const key = deriveTelemetryUserKey('account-1', secret)!;
    expect(key).not.toContain('account-1');
  });

  it('omits the key when the account or secret is missing', () => {
    // Better an absent field than an unkeyed digest that is linkable by anyone
    // who already holds the account id.
    expect(deriveTelemetryUserKey(undefined, secret)).toBeUndefined();
    expect(deriveTelemetryUserKey('account-1', undefined)).toBeUndefined();
  });
});

describe('formatGraphTelemetryLine', () => {
  it('emits one JSON line Cloud Logging can ingest', () => {
    const line = formatGraphTelemetryLine({
      family: 'section_pages', method: 'GET', status: 504, outcome: 'upstream',
      upstreamMs: 13000, preflightMs: 42, timedOut: true,
      syncRunId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', userKey: 'abc123def456',
    });
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ severity: 'INFO', event: 'graph_request', family: 'section_pages', status: 504, timedOut: true });
  });

  it('carries no free-text path or user fields', () => {
    const parsed = JSON.parse(formatGraphTelemetryLine({
      family: 'page_content', method: 'GET', status: 200, outcome: 'upstream', upstreamMs: 5, preflightMs: 3, timedOut: false,
    }));
    expect(Object.keys(parsed).sort()).toEqual(
      ['event', 'family', 'method', 'outcome', 'preflightMs', 'severity', 'status', 'timedOut', 'upstreamMs'].sort()
    );
  });
});


describe('sync run outcome', () => {
  it('accepts only the three known outcomes', () => {
    expect(isValidSyncRunOutcome('completed')).toBe(true);
    expect(isValidSyncRunOutcome('failed')).toBe(true);
    expect(isValidSyncRunOutcome('aborted')).toBe(true);
    expect(isValidSyncRunOutcome('cheap')).toBe(false);
    expect(isValidSyncRunOutcome(undefined)).toBe(false);
  });

  it('emits a run line that distinguishes a partial run from a cheap one', () => {
    // Without this, a run that died after three requests reads as a very
    // efficient sync when counting requests per syncRunId.
    const parsed = JSON.parse(formatSyncRunTelemetryLine({
      syncRunId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      outcome: 'failed',
      classCount: 2,
      userKey: 'abc123def456',
    }));
    expect(parsed).toMatchObject({ event: 'sync_run', outcome: 'failed', classCount: 2 });
  });
});


describe('OneNote budget families', () => {
  it('counts only OneNote traffic toward the documented per-user budget', () => {
    // The 400/hour figure is OneNote-service-specific. Identity, roster, mail
    // and chat are Graph traffic on the same account but a different budget;
    // counting them would overstate the cost of a sync.
    expect([...ONENOTE_BUDGET_FAMILIES].sort()).toEqual(
      ['notebooks', 'page_content', 'section_groups', 'section_pages', 'sections'].sort()
    );
    expect(isOneNoteBudgetFamily('section_pages')).toBe(true);
    expect(isOneNoteBudgetFamily('page_content')).toBe(true);
    expect(isOneNoteBudgetFamily('identity')).toBe(false);
    expect(isOneNoteBudgetFamily('roster')).toBe(false);
    expect(isOneNoteBudgetFamily('mail')).toBe(false);
    expect(isOneNoteBudgetFamily('chat')).toBe(false);
  });

  it('classifies the membership lookup outside the OneNote budget', () => {
    // The access-check lookup is Graph, not OneNote: telemetry keeps it, the
    // sync-cost calculation does not.
    expect(isOneNoteBudgetFamily(classifyGraphEndpointFamily('me/memberOf'))).toBe(false);
  });
});
