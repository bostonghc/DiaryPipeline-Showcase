
import { Client } from "@microsoft/microsoft-graph-client";
import { EducationClass, EmailResolutionResult, Student, StudentIdentity, JournalEntry, NotebookNode } from "../types";
import { parseJournalTable } from "./parserService";

const GRAPH_MAX_RETRIES = 4;
const GRAPH_BASE_DELAY_MS = 3000;
const GRAPH_DEFAULT_RETRY_AFTER_MS = 60000;

const isCollaborationSpaceName = (value: string): boolean => /collaboration space/i.test(value);
const isDiaryLikeName = (value: string): boolean => /diary|journal|week/i.test(value);
const isAssignmentsExcludedName = (value: string): boolean =>
  /collaboration space|content library|_teacher only/i.test(value) || value.startsWith('_');

const buildSectionLabel = (sectionName: string, lineage: string[]): string => {
  const studentContainer = [...lineage]
    .reverse()
    .find((name) => name && !isCollaborationSpaceName(name));

  return studentContainer || sectionName;
};

const normalizeComparableName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

const extractStudentNumber = (value: string): string | null => {
  const directMatch = value.match(/\b\d{7}\b/);
  if (directMatch) return directMatch[0];

  const upnStyleMatch = value.match(/[a-z]{2}(\d{7})/i);
  return upnStyleMatch ? upnStyleMatch[1] : null;
};

const toStudentIdentity = (member: any): StudentIdentity | null => {
  const graphId = String(member?.id || '');
  const displayName = String(member?.displayName || '').trim();
  const upn = String(member?.userPrincipalName || member?.mail || '').trim();
  const mail = String(member?.mail || member?.userPrincipalName || '').trim();

  if (!graphId || !displayName || !upn) return null;

  return {
    graphId,
    displayName,
    upn,
    ...(mail ? { mail } : {}),
  };
};

const parseRetryAfterMs = (headers: Headers | null): number | null => {
  if (!headers) return null;

  const retryAfter = headers.get('Retry-After');
  if (!retryAfter) return null;

  const retryAfterVal = parseInt(retryAfter, 10);
  if (!isNaN(retryAfterVal)) {
    return retryAfterVal * 1000 + 500;
  }

  const retryDate = new Date(retryAfter).getTime();
  if (!isNaN(retryDate)) {
    return Math.max(0, retryDate - Date.now()) + 500;
  }

  return null;
};

const createGraphRateLimitError = (retryAfterMs: number, retries: number): Error & { statusCode: number; code: string; retryAfterMs: number; retries: number } => {
  const error = new Error(`Microsoft Graph rate limit reached. Please retry in ${Math.ceil(retryAfterMs / 1000)}s.`);
  return Object.assign(error, {
    statusCode: 429,
    code: 'GRAPH_RATE_LIMIT',
    retryAfterMs,
    retries,
  });
};

class ConcurrencyLimiter {
  private queue: (() => void)[] = [];
  private activeCount = 0;
  constructor(private concurrency: number) {}

  async acquire(): Promise<void> {
    if (this.activeCount < this.concurrency) {
      this.activeCount++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) resolve();
    } else {
      this.activeCount--;
    }
  }
}

const limiter = new ConcurrencyLimiter(2); // Cap concurrent Graph requests conservatively

const fetchWithRetry = async (url: string, options: any, retries = 0): Promise<Response> => {
  await limiter.acquire();
  try {
    const response = await fetch(url, options);
    if (response.status === 429 || response.status >= 500) {
      if (response.status === 429) {
        console.log(`[Telemetry] graph_429_count`);
      }
      const retryAfterMs =
        parseRetryAfterMs(response.headers) ??
        GRAPH_BASE_DELAY_MS * Math.pow(2, retries) + Math.random() * 1000;

      if (response.status === 429 && retries >= GRAPH_MAX_RETRIES) {
        console.log(`[Telemetry] retry_exhausted`);
        throw createGraphRateLimitError(Math.round(retryAfterMs), retries);
      }

      if (retries >= GRAPH_MAX_RETRIES) {
        console.log(`[Telemetry] retry_exhausted`);
        return response;
      }
      
      console.log(`[Telemetry] retry_scheduled: ${response.status} in ${Math.round(retryAfterMs)}ms`);
      console.log(`[GraphService] Rate limited or server error (${response.status}). Retrying in ${Math.round(retryAfterMs)}ms... (Attempt ${retries + 1}/${GRAPH_MAX_RETRIES})`);
      await new Promise(res => setTimeout(res, retryAfterMs));
      return await fetchWithRetry(url, options, retries + 1);
    }
    return response;
  } catch (error) {
    if ((error as any)?.statusCode === 429 || (error as any)?.code === 'GRAPH_RATE_LIMIT') {
      throw error;
    }

    if (retries >= GRAPH_MAX_RETRIES) {
      console.log(`[Telemetry] retry_exhausted`);
      throw error;
    }
    const delay = GRAPH_BASE_DELAY_MS * Math.pow(2, retries) + Math.random() * 1000;
    console.log(`[Telemetry] retry_scheduled: network error in ${Math.round(delay)}ms`);
    console.log(`[GraphService] Network error. Retrying in ${Math.round(delay)}ms... (Attempt ${retries + 1}/${GRAPH_MAX_RETRIES})`);
    await new Promise(res => setTimeout(res, delay));
    return await fetchWithRetry(url, options, retries + 1);
  } finally {
    limiter.release();
  }
};

/**
 * Builds the request body for creating a 1:1 Teams chat between two resolved
 * directory users. Both members must bind via `users('{id}')` — the chat-post
 * API does NOT accept `/me` in `user@odata.bind` and rejects it with a
 * misleading "'user@odata.bind' field is missing in the request" error. The
 * caller resolves both member IDs before building this payload. Extracted as a
 * pure function so the member shape can be asserted in tests.
 */
export const buildOneOnOneChatPayload = (senderId: string, recipientId: string) => ({
  chatType: "oneOnOne",
  members: [
    {
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${senderId}')`,
    },
    {
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${recipientId}')`,
    },
  ],
});

// --- Structure audit (read-only, Slice 4) -------------------------------
// Ground-truth view of a class notebook's OneNote structure, used to confirm
// whether diary discovery is finding everything that actually exists. This is
// a diagnostic: it never mutates discovery behavior. For each section inside
// the Collaboration Space it reports both the count a single default `/pages`
// call returns (what getSectionPages currently sees) and the true paged count,
// so truncation from the missing `@odata.nextLink` handling is visible.

export interface AuditSectionCount {
  id: string;
  displayName: string;
  diaryLike: boolean;
  /** Pages returned by one default `.get()` — what getSectionPages currently discovers. */
  currentMethodCount: number;
  /** True if the default page had a nextLink, i.e. current code silently truncates here. */
  defaultHadNextLink: boolean;
  /** Full count after following every `@odata.nextLink`. */
  trueCount: number;
  /** trueCount - currentMethodCount; pages the current code drops. */
  droppedByCurrentMethod: number;
  error?: string;
}

export interface AuditSectionGroup {
  id: string;
  displayName: string;
  isCollaborationSpace: boolean;
  /** Mirrors getNotebookStructure diary mode: top-level groups are kept iff collab space. */
  keptByDiaryFilter: boolean;
  /** Mirrors getNotebookStructure assignments mode exclusion. */
  excludedByAssignmentsFilter: boolean;
  /** Whether per-section page counts were fetched (only under Collaboration Space). */
  countsFetched: boolean;
  sections: AuditSectionCount[];
  nestedGroups: AuditSectionGroup[];
}

export interface NotebookStructureAudit {
  classId: string;
  notebookId: string | null;
  generatedAt: string;
  warnings: string[];
  topLevelGroups: AuditSectionGroup[];
  totals: {
    /** Sections inside Collaboration Space (recursively) that name-match diary/journal/week. */
    diaryLikeSections: number;
    /** All sections inside Collaboration Space (recursively). */
    collabSpaceSections: number;
    collabPagesCurrentMethod: number;
    collabPagesTrue: number;
    collabPagesDropped: number;
  };
}

export class GraphService {
  private client: Client;
  private useProxy: boolean;
  private accessToken?: string;

  constructor(accessToken?: string, useProxy: boolean = false) {
    this.useProxy = useProxy;
    this.accessToken = accessToken;
    
    // Custom fetch implementation to route requests through our proxy
    const customFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (useProxy) {
        const urlStr = input.toString();
        const graphBase = "https://graph.microsoft.com/v1.0/";
        
        if (urlStr.startsWith(graphBase)) {
          const path = urlStr.substring(graphBase.length);
          const proxyUrl = `/api/graph/${path}`;
          
          // If we have a token, we can send it, but the proxy will primarily 
          // rely on the session cookie if the token is missing.
          const headers = new Headers(init?.headers);
          if (headers.get('Authorization') === 'Bearer dummy-token-for-proxy') {
            headers.delete('Authorization');
          }
          if (accessToken && !headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${accessToken}`);
          }
          
          return fetchWithRetry(proxyUrl, { ...init, headers });
        }
      }
      return fetchWithRetry(input.toString(), init);
    };

    this.client = Client.init({
      authProvider: (done) => {
        // Provide the token if we have it, otherwise provide a dummy string
        // The proxy will handle auth via session cookies if this is empty.
        // The Graph SDK throws an error if the token is completely empty.
        done(null, accessToken || "dummy-token-for-proxy");
      },
      fetchOptions: {
        // @ts-ignore
        customFetch: customFetch
      }
    });
  }

  private api(path: string) {
    if (this.useProxy) {
      // The Graph Client automatically prepends 'https://graph.microsoft.com/v1.0'
      // We must override the base URL for the client to point to our proxy instead.
      // However, the client doesn't easily let us change the base URL per request.
      // Instead, we will use a custom fetch implementation in the constructor.
      return this.client.api(path);
    }
    return this.client.api(path);
  }

  private getNotebookBasePath(classId: string, notebookId: string): string {
    return classId.startsWith('nb_')
      ? `/me/onenote/notebooks/${notebookId}`
      : `/groups/${classId}/onenote/notebooks/${notebookId}`;
  }

  private getSectionGroupBasePath(classId: string, sectionGroupId: string): string {
    return classId.startsWith('nb_')
      ? `/me/onenote/sectionGroups/${sectionGroupId}`
      : `/groups/${classId}/onenote/sectionGroups/${sectionGroupId}`;
  }

  private async collectDiarySections(
    classId: string,
    sectionGroupId: string,
    lineage: string[]
  ): Promise<NotebookNode[]> {
    const basePath = this.getSectionGroupBasePath(classId, sectionGroupId);
    const [sectionsResponse, nestedGroupsResponse] = await Promise.all([
      this.api(`${basePath}/sections`).select('id,displayName').get(),
      this.api(`${basePath}/sectionGroups`).select('id,displayName').get(),
    ]);

    const directSections = (sectionsResponse.value || []).map((section: any) => ({
      id: section.id,
      displayName: buildSectionLabel(section.displayName, lineage),
      type: 'section' as const,
      children: [],
    }));

    const nestedSections = (
      await Promise.all(
        (nestedGroupsResponse.value || []).map((group: any) =>
          this.collectDiarySections(classId, group.id, [...lineage, group.displayName])
        )
      )
    ).flat();

    const diarySections = directSections.filter((section) => isDiaryLikeName(section.displayName));
    if (diarySections.length > 0) return diarySections;
    if (nestedSections.length > 0) return nestedSections;

    return directSections;
  }

  async probeAccess(classId: string): Promise<'accessible' | 'inaccessible' | 'defer'> {
    try {
      let url = '';
      if (classId.startsWith('nb_')) {
        const realNotebookId = classId.substring(3);
        url = `/me/onenote/notebooks/${realNotebookId}`;
      } else {
        url = `/groups/${classId}/onenote/notebooks?$top=1`;
      }
      
      await this.api(url).select('id').get();
      return 'accessible';
    } catch (error: any) {
      const status = error.statusCode;
      if (status === 403 || status === 404) return 'inaccessible';
      if (status === 429 || status >= 500) return 'defer';
      if (status === 401) throw error; // Let 401 bubble up
      return 'inaccessible'; // Default to inaccessible for other errors
    }
  }

  async listClassStudentIdentities(classId: string): Promise<StudentIdentity[]> {
    if (!classId || classId.startsWith('nb_')) return [];

    let members: any = { value: [] };

    try {
      members = await this.api(`/education/classes/${classId}/members`)
        .query({ $select: 'id,displayName,mail,userPrincipalName' })
        .get();
    } catch (eduErr) {
      console.warn("Could not fetch education class members, trying groups API", eduErr);
      try {
        members = await this.api(`/groups/${classId}/members`)
          .query({ $select: 'id,displayName,mail,userPrincipalName' })
          .get();
      } catch (groupErr) {
        console.warn("Could not fetch group members", groupErr);
      }
    }

    const deduped = new Map<string, StudentIdentity>();
    (members.value || []).forEach((member: any) => {
      const identity = toStudentIdentity(member);
      if (identity) deduped.set(identity.graphId, identity);
    });

    return Array.from(deduped.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getClasses(filterStrings: string[] = []): Promise<EducationClass[]> {
    const classesMap = new Map<string, EducationClass>();
    
    let myId = "";
    
    const [meResult, eduResult, teamsResult, groupsResult, notebooksResult] = await Promise.allSettled([
      this.api("/me").select("id").get(),
      this.api("/education/classes").select("id,displayName,description").get(),
      this.api("/me/joinedTeams").select("id,displayName,description").get(),
      this.api("/me/memberOf").select("id,displayName,description,resourceProvisioningOptions").get(),
      this.api("/me/onenote/notebooks").select("id,displayName,createdBy").get()
    ]);

    const results = [meResult, eduResult, teamsResult, groupsResult, notebooksResult];
    const is401 = results.some(r => r.status === 'rejected' && (r.reason?.statusCode === 401 || r.reason?.message?.includes('401') || r.reason?.message?.includes('expired')));
    
    if (is401) {
      throw new Error("401 Unauthorized: Token expired");
    }

    if (meResult.status === 'fulfilled') {
      myId = meResult.value.id;
    } else {
      console.warn("Could not fetch current user profile.");
    }

    // Strategy 1: Education API (Official School Data)
    if (eduResult.status === 'fulfilled' && eduResult.value.value) {
      eduResult.value.value.forEach((c: any) => {
        classesMap.set(c.id, { id: c.id, displayName: c.displayName, description: c.description || "Education Class" });
      });
    } else if (eduResult.status === 'rejected') {
      console.warn("Education API not available or restricted.");
    }

    // Strategy 2: Joined Teams (Where Class Notebooks live)
    if (teamsResult.status === 'fulfilled' && teamsResult.value.value) {
      teamsResult.value.value.forEach((t: any) => {
        if (!classesMap.has(t.id)) {
          classesMap.set(t.id, { id: t.id, displayName: t.displayName, description: t.description || "Microsoft Team" });
        }
      });
    } else if (teamsResult.status === 'rejected') {
      console.warn("Teams API fallback failed.");
    }

    // Strategy 3: Member Of Groups (Refined search)
    if (groupsResult.status === 'fulfilled' && groupsResult.value.value) {
      const filters = filterStrings.map(f => f.toLowerCase());
      
      groupsResult.value.value
        .filter((g: any) => {
          if (g["@odata.type"] !== "#microsoft.graph.group") return false;
          
          const name = g.displayName?.toLowerCase() || "";
          const desc = g.description?.toLowerCase() || "";
          
          const isTeam = g.resourceProvisioningOptions?.includes("Team");
          const isClass = desc.includes("class") || name.includes("class");
          const matchesCustomFilter = filters.some(f => name.includes(f) || desc.includes(f));
          
          return isTeam || isClass || matchesCustomFilter;
        })
        .forEach((g: any) => {
          if (!classesMap.has(g.id)) {
            classesMap.set(g.id, { id: g.id, displayName: g.displayName, description: g.description || "M365 Group" });
          }
        });
    } else if (groupsResult.status === 'rejected') {
      console.error("Groups retrieval failed:", groupsResult.reason);
    }
    
    // Strategy 4: Direct Notebook Search (If they aren't in groups/teams)
    if (notebooksResult.status === 'fulfilled' && notebooksResult.value.value) {
      notebooksResult.value.value.forEach((nb: any) => {
        // Filter by teacher: only show notebooks created by the current user
        const creatorId = nb.createdBy?.user?.id;
        if (myId && creatorId && creatorId !== myId) {
          return; // Skip notebooks created by other teachers
        }

        // Use the notebook ID as the class ID, prefix with 'nb_' to distinguish
        const fakeClassId = `nb_${nb.id}`;
        if (!classesMap.has(fakeClassId)) {
          classesMap.set(fakeClassId, { 
            id: fakeClassId, 
            displayName: nb.displayName, 
            description: `Direct Notebook (Created by ${nb.createdBy?.user?.displayName || 'You'})` 
          });
        }
      });
    } else if (notebooksResult.status === 'rejected') {
      console.warn("Direct notebook search failed.");
    }

    const finalClasses = Array.from(classesMap.values());
    
    // If user has provided custom filter strings, apply them globally to the results
    if (filterStrings.length > 0) {
      const filters = filterStrings.map(f => f.toLowerCase());
      return finalClasses.filter(c => {
        const name = c.displayName?.toLowerCase() || "";
        const desc = c.description?.toLowerCase() || "";
        return filters.some(f => name.includes(f) || desc.includes(f));
      });
    }

    return finalClasses;
  }

  async getNotebookStructure(classId: string, mode: 'diary' | 'assignments' = 'diary'): Promise<NotebookNode[]> {
    const tree: NotebookNode[] = [];
    
    try {
      let classNotebook: any = null;

      if (classId.startsWith('nb_')) {
        const realNotebookId = classId.substring(3);
        classNotebook = { id: realNotebookId };
      } else {
        const notebooks = await this.api(`/groups/${classId}/onenote/notebooks`).get();
        classNotebook = notebooks.value.find((nb: any) => 
          nb.isDefault === true || 
          nb.displayName.toLowerCase().includes("class notebook") || 
          nb.displayName.includes("クラス ノートブック") || 
          nb.displayName.toLowerCase().includes("notebook")
        );
      }
      
      if (!classNotebook) throw new Error("No Class Notebook found in this group/team.");

      const basePath = this.getNotebookBasePath(classId, classNotebook.id);

      // Fetch Section Groups
      const sectionGroups = await this.api(`${basePath}/sectionGroups`).expand("sections").get();
      
      for (const sg of sectionGroups.value) {
        const sgNameLower = sg.displayName.toLowerCase();
        
        if (mode === 'diary') {
          if (!sgNameLower.includes("collaboration space")) continue;
        } else {
          if (isAssignmentsExcludedName(sgNameLower)) {
            continue;
          }
        }

        const sgNode: NotebookNode = {
          id: sg.id,
          displayName: sg.displayName,
          type: 'sectionGroup',
          children: []
        };

        if (mode === 'diary') {
          const diarySections = await this.collectDiarySections(classId, sg.id, [sg.displayName]);
          sgNode.children = diarySections;
        } else {
          // For each section in the group
          for (const section of sg.sections || []) {
            const sectionNode: NotebookNode = {
              id: section.id,
              displayName: section.displayName,
              type: 'section',
              children: [] // Pages will be lazy-loaded
            };

            sgNode.children!.push(sectionNode);
          }
        }

        tree.push(sgNode);
      }
    } catch (error: any) {
      console.error("Structure fetch error:", error);
      throw error;
    }

    return tree;
  }

  async getSectionPages(classId: string, sectionId: string): Promise<NotebookNode[]> {
    const pages: NotebookNode[] = [];
    const checkpointKey = `checkpoint_${classId}_${sectionId}`;
    const lastCheckpoint = localStorage.getItem(checkpointKey);
    const lastSyncTime = lastCheckpoint ? new Date(lastCheckpoint) : new Date(0);

    try {
      const sectionBasePath = classId.startsWith('nb_') 
        ? `/me/onenote/sections/${sectionId}`
        : `/groups/${classId}/onenote/sections/${sectionId}`;
        
      // Fetch metadata first
      const pagesResponse = await this.api(`${sectionBasePath}/pages`)
        .select("id,title,lastModifiedDateTime,contentUrl")
        .get();

      for (const page of pagesResponse.value) {
        const title = page.title || "Untitled Page";
        const match = title.match(/(?<!\d)(\d{7})(?!\d)/);
        
        const pageModifiedTime = new Date(page.lastModifiedDateTime);
        const hasChanged = pageModifiedTime > lastSyncTime;
        
        let displayName = title;
        if (match) {
          const studentId = match[1];
          let studentName = title.replace(studentId, '').trim().replace(/^[-:\s@]+/, '').replace(/^[Aa]t\s+/, '');
          displayName = `${studentId} - ${studentName || 'Unknown'}`;
        } else {
          displayName = `? ${title}`;
        }

        // We can add a visual indicator if it has changed since last sync
        if (hasChanged && lastCheckpoint) {
          displayName = `* ${displayName}`;
        }

        pages.push({
          id: page.id,
          displayName: displayName,
          type: 'page',
          contentUrl: page.contentUrl,
          lastModified: page.lastModifiedDateTime || pageModifiedTime.toISOString()
        });
      }
      
      // Update checkpoint
      localStorage.setItem(checkpointKey, new Date().toISOString());
      
    } catch (err: any) {
      if (err.statusCode === 401 || err.message?.includes('401') || err.message?.includes('expired')) {
        throw err;
      }
      console.warn(`Failed to fetch pages for section ${sectionId}`, err);
      pages.push({
        id: `error-${sectionId}`,
        displayName: `⚠️ Error loading pages: ${err.message || 'Unknown API Error'}`,
        type: 'page',
        contentUrl: '',
        lastModified: ''
      });
    }
    return pages;
  }

  /**
   * Read-only structure audit (Slice 4). Walks the notebook's section groups
   * without applying the diary/assignments filters, and for sections inside the
   * Collaboration Space reports current-method vs. true page counts so we can
   * tell a genuinely sparse class from one whose pages are being truncated.
   * Never mutates discovery; safe to run repeatedly.
   */
  async auditNotebookStructure(classId: string): Promise<NotebookStructureAudit> {
    const warnings: string[] = [];

    let notebookId: string | null = null;
    if (classId.startsWith('nb_')) {
      notebookId = classId.substring(3);
    } else {
      const notebooks = await this.api(`/groups/${classId}/onenote/notebooks`).get();
      const nb = (notebooks.value || []).find((n: any) =>
        n.isDefault === true ||
        n.displayName?.toLowerCase().includes('class notebook') ||
        n.displayName?.includes('クラス ノートブック') ||
        n.displayName?.toLowerCase().includes('notebook')
      );
      notebookId = nb?.id ?? null;
    }
    if (!notebookId) throw new Error('No Class Notebook found for this class.');

    const basePath = this.getNotebookBasePath(classId, notebookId);
    const groupsResp = await this.api(`${basePath}/sectionGroups`).select('id,displayName').get();

    const topLevelGroups: AuditSectionGroup[] = [];
    for (const sg of groupsResp.value || []) {
      const isCollab = isCollaborationSpaceName(sg.displayName);
      topLevelGroups.push(await this.auditSectionGroup(classId, sg.id, sg.displayName, isCollab));
    }

    const totals = {
      diaryLikeSections: 0,
      collabSpaceSections: 0,
      collabPagesCurrentMethod: 0,
      collabPagesTrue: 0,
      collabPagesDropped: 0,
    };
    const tallyCollab = (group: AuditSectionGroup) => {
      if (!group.countsFetched) return;
      for (const s of group.sections) {
        totals.collabSpaceSections += 1;
        if (s.diaryLike) totals.diaryLikeSections += 1;
        totals.collabPagesCurrentMethod += s.currentMethodCount;
        totals.collabPagesTrue += s.trueCount;
        totals.collabPagesDropped += s.droppedByCurrentMethod;
      }
      group.nestedGroups.forEach(tallyCollab);
    };
    topLevelGroups.forEach(tallyCollab);

    if (totals.collabSpaceSections === 0) {
      warnings.push('No sections found inside a "Collaboration Space" section group — diary discovery would find nothing here.');
    }
    if (totals.collabPagesDropped > 0) {
      warnings.push(`${totals.collabPagesDropped} diary page(s) exist beyond the first response and are dropped by the current (un-paginated) getSectionPages.`);
    }

    return {
      classId,
      notebookId,
      generatedAt: new Date().toISOString(),
      warnings,
      topLevelGroups,
      totals,
    };
  }

  private async auditSectionGroup(
    classId: string,
    sectionGroupId: string,
    displayName: string,
    fetchCounts: boolean
  ): Promise<AuditSectionGroup> {
    const basePath = this.getSectionGroupBasePath(classId, sectionGroupId);
    const [sectionsResp, nestedResp] = await Promise.all([
      this.api(`${basePath}/sections`).select('id,displayName').get(),
      this.api(`${basePath}/sectionGroups`).select('id,displayName').get(),
    ]);

    const sections: AuditSectionCount[] = [];
    for (const s of sectionsResp.value || []) {
      if (fetchCounts) {
        sections.push(await this.auditSectionPages(classId, s.id, s.displayName));
      } else {
        sections.push({
          id: s.id,
          displayName: s.displayName,
          diaryLike: isDiaryLikeName(s.displayName),
          currentMethodCount: 0,
          defaultHadNextLink: false,
          trueCount: 0,
          droppedByCurrentMethod: 0,
        });
      }
    }

    const nestedGroups: AuditSectionGroup[] = [];
    for (const ng of nestedResp.value || []) {
      // Descend with the same fetch flag: sections nested inside the Collaboration
      // Space are where per-student diary groups live in older notebooks.
      nestedGroups.push(await this.auditSectionGroup(classId, ng.id, ng.displayName, fetchCounts));
    }

    return {
      id: sectionGroupId,
      displayName,
      isCollaborationSpace: isCollaborationSpaceName(displayName),
      keptByDiaryFilter: isCollaborationSpaceName(displayName),
      excludedByAssignmentsFilter: isAssignmentsExcludedName(displayName.toLowerCase()),
      countsFetched: fetchCounts,
      sections,
      nestedGroups,
    };
  }

  private async auditSectionPages(
    classId: string,
    sectionId: string,
    displayName: string
  ): Promise<AuditSectionCount> {
    const diaryLike = isDiaryLikeName(displayName);
    const sectionBasePath = classId.startsWith('nb_')
      ? `/me/onenote/sections/${sectionId}`
      : `/groups/${classId}/onenote/sections/${sectionId}`;

    try {
      // Replicate the exact call getSectionPages makes (no $top) to measure what
      // the current code would discover, then follow nextLink for the true total.
      const first = await this.api(`${sectionBasePath}/pages`)
        .select('id,title,lastModifiedDateTime,contentUrl')
        .get();

      const currentMethodCount = (first.value || []).length;
      let trueCount = currentMethodCount;
      let next: string | undefined = first['@odata.nextLink'];
      const defaultHadNextLink = !!next;

      let guard = 0;
      while (next && guard < 100) {
        const page = await this.api(next).get();
        trueCount += (page.value || []).length;
        next = page['@odata.nextLink'];
        guard += 1;
      }

      return {
        id: sectionId,
        displayName,
        diaryLike,
        currentMethodCount,
        defaultHadNextLink,
        trueCount,
        droppedByCurrentMethod: trueCount - currentMethodCount,
      };
    } catch (err: any) {
      return {
        id: sectionId,
        displayName,
        diaryLike,
        currentMethodCount: 0,
        defaultHadNextLink: false,
        trueCount: 0,
        droppedByCurrentMethod: 0,
        error: err?.message || 'Failed to count pages',
      };
    }
  }

  async getPageContent(classId: string, pageId: string): Promise<string> {
    try {
      const pageBasePath = classId.startsWith('nb_') 
        ? `/me/onenote/pages/${pageId}`
        : `/groups/${classId}/onenote/pages/${pageId}`;
        
      let htmlContent = await this.api(`${pageBasePath}/content`).responseType('text' as any).get();
      
      // If the Graph client still auto-parses it into an HTMLDocument in the browser, extract the HTML string
      if (typeof htmlContent === 'object' && htmlContent.documentElement) {
        htmlContent = htmlContent.documentElement.outerHTML;
      } else if (typeof htmlContent === 'object') {
        htmlContent = htmlContent.body?.innerHTML || htmlContent.toString();
      }
      
      return htmlContent;
    } catch (error: any) {
      if (error.statusCode === 401 || error.message?.includes('401') || error.message?.includes('expired')) {
        throw error;
      }
      const errorDetails = error.response ? await error.response.text() : error.message;
      console.error("Failed to fetch page content:", errorDetails, error);
      throw new Error(`Failed to fetch page content: ${errorDetails}`);
    }
  }

  async syncJournalEntries(classId: string): Promise<JournalEntry[]> {
    const entries: JournalEntry[] = [];
    
    try {
      let classNotebook: any = null;

      // Check if this is a direct notebook (from Strategy 4)
      if (classId.startsWith('nb_')) {
        const realNotebookId = classId.substring(3);
        classNotebook = { id: realNotebookId };
      } else {
        // It's a group/team, so find the notebook inside it
        const notebooks = await this.api(`/groups/${classId}/onenote/notebooks`).get();
        classNotebook = notebooks.value.find((nb: any) => 
          nb.isDefault === true || 
          nb.displayName.toLowerCase().includes("class notebook") || 
          nb.displayName.includes("クラス ノートブック") || 
          nb.displayName.toLowerCase().includes("notebook")
        );
      }
      
      if (!classNotebook) throw new Error("No Class Notebook found in this group/team.");

      // If it's a direct notebook, we query /me/onenote/notebooks/{id}
      // If it's a group notebook, we query /groups/{id}/onenote/notebooks/{id}
      const basePath = classId.startsWith('nb_') 
        ? `/me/onenote/notebooks/${classNotebook.id}`
        : `/groups/${classId}/onenote/notebooks/${classNotebook.id}`;

      const sectionGroups = await this.api(`${basePath}/sectionGroups`).expand("sections").get();
      
      for (const sg of sectionGroups.value) {
        if (sg.displayName.startsWith('_') || sg.displayName === "Content Library" || sg.displayName === "Collaboration Space") continue;

        for (const section of sg.sections || []) {
          try {
            const pagesResponse = await this.api(`/onenote/sections/${section.id}/pages`)
              .select("id,title,lastModifiedDateTime")
              .get();

            for (const page of pagesResponse.value) {
              let htmlContent = await this.api(`/onenote/pages/${page.id}/content`).responseType('text' as any).get();
              
              if (typeof htmlContent === 'object' && htmlContent.documentElement) {
                htmlContent = htmlContent.documentElement.outerHTML;
              } else if (typeof htmlContent === 'object') {
                htmlContent = htmlContent.body?.innerHTML || htmlContent.toString();
              }
              
              const cells = parseJournalTable(htmlContent);

              if (cells) {
                entries.push({
                  studentId: sg.id,
                  studentName: sg.displayName,
                  pageId: page.id,
                  pageTitle: page.title,
                  date: new Date(page.lastModifiedDateTime).toLocaleDateString(),
                  cells: cells
                });
              }
            }
          } catch (err) {
            continue;
          }
        }
      }
    } catch (error: any) {
      console.error("Crawl error:", error);
      throw error;
    }

    return entries;
  }

  async resolveStudentIdentity(studentName: string, classId?: string): Promise<StudentIdentity | null> {
    try {
      // 1. Extract potential Student ID (e.g., "1234567" from "1234567 - John Doe")
      // We look for a block of digits (typically 5-9 digits in EDU tenants)
      const studentId = extractStudentNumber(studentName);

      // Clean up name if it has IDs (e.g., "1234567 - John Doe" -> "John Doe")
      const cleanName = studentName.replace(/^\d+[-:\s]+/, '').trim();
      const lowerName = cleanName.toLowerCase();
      const comparableName = normalizeComparableName(cleanName);
      
      // BEST PRACTICE: If we have the classId (Group ID), fetch the members and match locally.
      // This bypasses Graph API's strict search limitations and handles localization/formatting differences better.
      if (classId && !classId.startsWith('nb_')) {
        const members = await this.listClassStudentIdentities(classId);

        if (members.length > 0) {
          let match;

          // STRATEGY A: Match by Student ID (Highly Reliable)
          // If the UPN is ab1234567@school.edu, this is a guaranteed match.
          if (studentId) {
            match = members.find((m) => {
              const upn = (m.upn || '').toLowerCase();
              const mail = (m.mail || '').toLowerCase();
              return upn.includes(studentId) || mail.includes(studentId);
            });
          }

            // STRATEGY B: Name Matching Fallbacks
            if (!match) {
              // 1. Try exact match (case-insensitive)
              match = members.find((m) => m.displayName?.toLowerCase() === lowerName);

              // 1b. Try normalized exact match without spaces/punctuation
              if (!match && comparableName) {
                match = members.find((m) =>
                  normalizeComparableName(m.displayName || '') === comparableName
                );
              }
              
              // 2. Try partial match (e.g., OneNote has "John Doe", Directory has "Doe, John" or "John Doe (Student)")
              if (!match) {
                match = members.find((m) => {
                  const dirName = m.displayName?.toLowerCase() || '';
                  return dirName.includes(lowerName) || lowerName.includes(dirName);
                });
              }

              // 2b. Try normalized partial match without spaces/punctuation
              if (!match && comparableName) {
                match = members.find((m) => {
                  const dirName = normalizeComparableName(m.displayName || '');
                  return dirName.includes(comparableName) || comparableName.includes(dirName);
                });
              }
              
              // 3. Try matching by parts (first name / last name)
              if (!match) {
                const nameParts = lowerName.split(/\s+/).filter(p => p.length > 2);
                if (nameParts.length > 0) {
                  match = members.find((m) => {
                    const dirName = m.displayName?.toLowerCase() || '';
                    return nameParts.every(part => dirName.includes(part));
                  });
                }
              }
            }
            
            if (match) {
              return match;
            }
          }
        }
      if (studentId) {
        try {
          // Use $filter startswith on UPN — more reliable than $search for ID substrings.
          // $search requires property:value KQL format and does word-boundary matching,
          // not substring matching, so "1234567" won't find "ak1234567@school.edu".
          const escapedId = studentId.replace(/'/g, "''");
          const idResult = await this.api('/users')
            .query({ $filter: `startswith(userPrincipalName,'${escapedId}') or startswith(mail,'${escapedId}')`, $select: 'id,displayName,mail,userPrincipalName' })
            .get();

          if (idResult.value && idResult.value.length > 0) {
            return toStudentIdentity(idResult.value[0]);
          }
        } catch (idErr) {
          console.warn("Global ID search failed", idErr);
        }
      }

      // STRATEGY D: Global Directory Search by Name (Attempt 1: $search with property:value KQL)
      // Graph $search requires "property:value" format — bare quoted terms are rejected with 400.
      if (cleanName) {
        try {
          const searchTerms = cleanName.split(/\s+/).filter(p => p.length > 0)
            .map(p => `"displayName:${p}"`).join(' AND ');
          let result = await this.api('/users')
            .header('ConsistencyLevel', 'eventual')
            .query({ $search: searchTerms, $select: 'id,displayName,mail,userPrincipalName' })
            .get();
          
          if (result.value && result.value.length > 0) {
            if (studentId) {
              const match = result.value.find((m: any) => {
                const upn = (m.userPrincipalName || '').toLowerCase();
                const mail = (m.mail || '').toLowerCase();
                return upn.includes(studentId) || mail.includes(studentId);
              });
              if (match) return toStudentIdentity(match);
            }
            return toStudentIdentity(result.value[0]);
          }
        } catch (searchErr) {
          console.warn("Global name search failed", searchErr);
        }

        // STRATEGY E: Global Directory Search by Name (Attempt 2: Fallback to startswith filter on displayName)
        try {
          // Escape single quotes in the name for the OData filter
          const escapedName = cleanName.replace(/'/g, "''");
          const result = await this.api('/users')
            .query({ $filter: `startswith(displayName,'${escapedName}')`, $select: 'id,displayName,mail,userPrincipalName' })
            .get();

          if (result.value && result.value.length > 0) {
            if (studentId) {
              const match = result.value.find((m: any) => {
                const upn = (m.userPrincipalName || '').toLowerCase();
                const mail = (m.mail || '').toLowerCase();
                return upn.includes(studentId) || mail.includes(studentId);
              });
              if (match) return toStudentIdentity(match);
            }
            return toStudentIdentity(result.value[0]);
          }
        } catch (filterErr) {
          console.warn("Global name filter failed", filterErr);
        }
      }

      return null;
    } catch (e) {
      console.error("Error resolving student identity:", e);
      return null;
    }
  }

  async findStudentEmail(
    studentName: string,
    classId?: string
  ): Promise<EmailResolutionResult | null> {
    // Run the full resolution and annotate which path succeeded.
    // Roster path: resolveStudentIdentity succeeds because classId is present
    // and the class member list contains a match (Strategies A/B).
    // Graph search path: classId absent, not a class group, or roster miss
    // caused fallthrough to live directory queries (Strategies C/D/E).
    //
    // We distinguish by re-running the cheap roster check first. If the
    // identity can be sourced from the in-memory member list, it's 'roster';
    // otherwise the full resolve fell through to Graph search.
    try {
      const email = await (async () => {
        const identity = await this.resolveStudentIdentity(studentName, classId);
        return identity?.mail || identity?.upn || null;
      })();

      if (!email) return null;

      // Determine source: attempt a roster-only check to see if the match
      // came from the class member list.
      let source: EmailResolutionResult['source'] = 'graph_search';
      if (classId && !classId.startsWith('nb_')) {
        try {
          const members = await this.listClassStudentIdentities(classId);
          const found = members.some(
            (m) =>
              (m.mail && m.mail.toLowerCase() === email.toLowerCase()) ||
              (m.upn && m.upn.toLowerCase() === email.toLowerCase())
          );
          if (found) source = 'roster';
        } catch {
          // Roster check failed — keep source as graph_search
        }
      }

      return { email, source };
    } catch (e) {
      console.error('findStudentEmail failed', e);
      return null;
    }
  }

  async sendEmail(toEmail: string, subject: string, htmlBody: string): Promise<void> {
    try {
      const message = {
        message: {
          subject: subject,
          body: {
            contentType: "HTML",
            content: htmlBody
          },
          toRecipients: [
            { emailAddress: { address: toEmail } }
          ]
        },
        saveToSentItems: "true"
      };
      await this.api('/me/sendMail').post(message);
    } catch (error: any) {
      console.error("Failed to send email:", error);
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  async sendTeamsMessage(toEmail: string, htmlBody: string): Promise<void> {
    // Use direct fetch rather than the Graph SDK's .post() so we keep full
    // control over the request body and headers for the chat-creation call.
    const graphFetch = async (
      path: string,
      method: 'GET' | 'POST',
      body?: unknown
    ): Promise<Response> => {
      const url = this.useProxy
        ? `/api/graph/${path}`
        : `https://graph.microsoft.com/v1.0/${path}`;
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;
      return fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    };

    try {
      // Resolve both chat members to directory object IDs first. The chat-post
      // API requires users('{id}') binds and rejects '/me' with a misleading
      // "'user@odata.bind' field is missing" error.
      const meResp = await graphFetch('me?$select=id', 'GET');
      if (!meResp.ok) {
        throw new Error(`Could not resolve the signed-in user in Microsoft Graph (${meResp.status})`);
      }
      const me = await meResp.json();

      const recipientResp = await graphFetch(`users/${encodeURIComponent(toEmail)}?$select=id`, 'GET');
      if (!recipientResp.ok) {
        throw new Error(`Could not resolve Teams recipient in Microsoft Graph: ${toEmail}`);
      }
      const recipient = await recipientResp.json();

      // 1. Create or get 1:1 chat
      const chatResp = await graphFetch('chats', 'POST', buildOneOnOneChatPayload(me.id, recipient.id));
      if (!chatResp.ok) {
        const err = await chatResp.json().catch(() => ({}));
        throw new Error(err?.error?.message || `Chat creation failed (${chatResp.status})`);
      }
      const chat = await chatResp.json();

      // 2. Send message
      const msgResp = await graphFetch(`chats/${chat.id}/messages`, 'POST', {
        body: { contentType: 'html', content: htmlBody },
      });
      if (!msgResp.ok) {
        const err = await msgResp.json().catch(() => ({}));
        throw new Error(err?.error?.message || `Message send failed (${msgResp.status})`);
      }
    } catch (error: any) {
      console.error('Failed to send Teams message:', error);
      throw new Error(`Failed to send Teams message: ${error.message}`);
    }
  }
}
