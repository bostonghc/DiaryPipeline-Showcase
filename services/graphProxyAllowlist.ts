/**
 * Allowlist for the Graph proxy (server.ts `/api/graph/*`). The proxy forwards
 * requests to https://graph.microsoft.com/v1.0/<path>; without a filter it would
 * relay any path/method an authenticated session can reach. This restricts it to
 * exactly the (method, path) pairs the app actually issues — anything else is
 * rejected with 403 before a token is attached.
 *
 * `path` is the segment after `/api/graph/` (Express `req.params[0]`), without a
 * leading slash and without the query string.
 */
export interface GraphProxyRule {
  method: 'GET' | 'POST';
  pattern: RegExp;
}

export const GRAPH_PROXY_ALLOWLIST: GraphProxyRule[] = [
  // Identity / membership
  { method: 'GET', pattern: /^me$/ },
  { method: 'GET', pattern: /^me\/joinedTeams$/ },
  { method: 'GET', pattern: /^me\/memberOf$/ },
  // OneNote (personal + group-scoped notebooks, sections, pages)
  { method: 'GET', pattern: /^me\/onenote(\/.*)?$/ },
  { method: 'GET', pattern: /^groups\/[^/]+\/onenote(\/.*)?$/ },
  { method: 'GET', pattern: /^groups\/[^/]+\/members$/ },
  // Education roster
  { method: 'GET', pattern: /^education\/classes$/ },
  { method: 'GET', pattern: /^education\/classes\/[^/]+\/members$/ },
  // Directory lookup (student email resolution; search via query params)
  { method: 'GET', pattern: /^users(\/[^/]+)?$/ },
  // Send flows
  { method: 'POST', pattern: /^me\/sendMail$/ },
  { method: 'POST', pattern: /^chats$/ },
  { method: 'POST', pattern: /^chats\/[^/]+\/messages$/ },
];

/**
 * True when (method, path) matches an allowlisted Graph call. Tolerates a
 * leading slash, a trailing slash, and an attached query string on `path`.
 */
export const isGraphPathAllowed = (method: string, path: string): boolean => {
  const normalized = path
    .split('?')[0]
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const upper = method.toUpperCase();
  return GRAPH_PROXY_ALLOWLIST.some(
    (rule) => rule.method === upper && rule.pattern.test(normalized)
  );
};
