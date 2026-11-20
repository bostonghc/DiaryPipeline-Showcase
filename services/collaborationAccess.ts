export type CollaborationRole = 'owner' | 'lead' | 'intern';

export interface CollaborationMembership {
  id: string;
  displayName?: string;
}

export interface CollaborationConfig {
  pilotEnabled: boolean;
  ownerUpns: string[];
  leadUpns: string[];
  pilotClassIds: string[];
  aiReviewRoles: CollaborationRole[];
}

export interface CollaborationCapabilities {
  canSendFeedback: boolean;
  canReviewAllFeedback: boolean;
  canExport: boolean;
  canSync: boolean;
  canManageSettings: boolean;
  canManageAccess: boolean;
  canUseAiReview: boolean;
}

export type CollaborationClassScope =
  | { kind: 'all' }
  | { kind: 'classes'; classIds: string[] };

export type CollaborationProfileSource =
  | 'legacy_single_user'
  | 'configured_role'
  | 'm365_membership';

export interface CollaborationAccessProfile {
  pilotEnabled: boolean;
  allowed: boolean;
  role: CollaborationRole | null;
  upn: string;
  displayName: string;
  classScope: CollaborationClassScope;
  capabilities: CollaborationCapabilities;
  source: CollaborationProfileSource;
  resolvedAt: string;
  reason?: 'not_configured' | 'not_assigned';
}

type Environment = Record<string, string | undefined>;

const normalizeUpn = (value: string): string => value.trim().toLowerCase();

const parseCsv = (value?: string): string[] => Array.from(new Set(
  (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
));

export const readCollaborationConfig = (env: Environment): CollaborationConfig => ({
  pilotEnabled: env.COLLABORATION_PILOT_ENABLED?.trim().toLowerCase() === 'true',
  ownerUpns: parseCsv(env.COLLABORATION_OWNER_UPNS).map(normalizeUpn),
  leadUpns: parseCsv(env.COLLABORATION_LEAD_UPNS).map(normalizeUpn),
  pilotClassIds: parseCsv(env.COLLABORATION_CLASS_IDS),
  aiReviewRoles: parseCsv(env.AI_REVIEW_ROLES)
    .map((item) => item.toLowerCase())
    .filter((item): item is CollaborationRole => item === 'lead' || item === 'intern'),
});

const capabilitiesForRole = (
  role: CollaborationRole | null,
  config: CollaborationConfig
): CollaborationCapabilities => {
  if (role === 'owner') {
    return {
      canSendFeedback: true,
      canReviewAllFeedback: true,
      canExport: true,
      canSync: true,
      canManageSettings: true,
      canManageAccess: true,
      canUseAiReview: true,
    };
  }

  if (role === 'lead') {
    return {
      canSendFeedback: true,
      canReviewAllFeedback: true,
      canExport: true,
      canSync: true,
      canManageSettings: false,
      canManageAccess: false,
      canUseAiReview: config.aiReviewRoles.includes('lead'),
    };
  }

  if (role === 'intern') {
    return {
      canSendFeedback: true,
      canReviewAllFeedback: false,
      canExport: false,
      canSync: true,
      canManageSettings: false,
      canManageAccess: false,
      canUseAiReview: config.aiReviewRoles.includes('intern'),
    };
  }

  return {
    canSendFeedback: false,
    canReviewAllFeedback: false,
    canExport: false,
    canSync: false,
    canManageSettings: false,
    canManageAccess: false,
    canUseAiReview: false,
  };
};

export const resolveCollaborationAccess = (
  config: CollaborationConfig,
  account: { username?: string; name?: string },
  memberships: CollaborationMembership[] = [],
  resolvedAt = new Date().toISOString()
): CollaborationAccessProfile => {
  const upn = normalizeUpn(account.username || '');
  const displayName = account.name?.trim() || account.username?.trim() || 'Microsoft user';

  // Local and pre-pilot deployments preserve the existing single-user behavior.
  if (!config.pilotEnabled) {
    return {
      pilotEnabled: false,
      allowed: true,
      role: 'owner',
      upn,
      displayName,
      classScope: { kind: 'all' },
      capabilities: capabilitiesForRole('owner', config),
      source: 'legacy_single_user',
      resolvedAt,
      reason: 'not_configured',
    };
  }

  if (config.ownerUpns.includes(upn)) {
    return {
      pilotEnabled: true,
      allowed: true,
      role: 'owner',
      upn,
      displayName,
      classScope: { kind: 'all' },
      capabilities: capabilitiesForRole('owner', config),
      source: 'configured_role',
      resolvedAt,
    };
  }

  if (config.leadUpns.includes(upn)) {
    return {
      pilotEnabled: true,
      allowed: true,
      role: 'lead',
      upn,
      displayName,
      classScope: { kind: 'classes', classIds: [...config.pilotClassIds] },
      capabilities: capabilitiesForRole('lead', config),
      source: 'configured_role',
      resolvedAt,
    };
  }

  const membershipIds = new Set(memberships.map((membership) => membership.id));
  const assignedClassIds = config.pilotClassIds.filter((classId) => membershipIds.has(classId));
  if (assignedClassIds.length > 0) {
    return {
      pilotEnabled: true,
      allowed: true,
      role: 'intern',
      upn,
      displayName,
      classScope: { kind: 'classes', classIds: assignedClassIds },
      capabilities: capabilitiesForRole('intern', config),
      source: 'm365_membership',
      resolvedAt,
    };
  }

  return {
    pilotEnabled: true,
    allowed: false,
    role: null,
    upn,
    displayName,
    classScope: { kind: 'classes', classIds: [] },
    capabilities: capabilitiesForRole(null, config),
    source: 'm365_membership',
    resolvedAt,
    reason: 'not_assigned',
  };
};

export const isClassScopedGraphPathAllowed = (
  profile: CollaborationAccessProfile,
  path: string
): boolean => {
  if (profile.classScope.kind === 'all') return true;
  // Any class-scoped role (lead or intern) is checked against its class list.
  // Gating on a specific role here silently denied every lead request.
  if (!profile.allowed) return false;

  const normalized = path.split('?')[0].replace(/^\/+/, '').replace(/\/+$/, '');
  const groupMatch = normalized.match(/^groups\/([^/]+)\/(?:onenote|members)(?:\/.*)?$/);
  if (groupMatch) return profile.classScope.classIds.includes(groupMatch[1]);

  const educationClassMatch = normalized.match(/^education\/classes\/([^/]+)\/members$/);
  if (educationClassMatch) return profile.classScope.classIds.includes(educationClassMatch[1]);

  // These endpoints either describe the signed-in user or support the trusted
  // cohort's direct feedback workflow. Class visibility is the pilot boundary;
  // recipients are not separately allowlisted.
  return /^(?:me|me\/memberOf|me\/joinedTeams|education\/classes|users(?:\/.*)?|me\/sendMail|chats(?:\/.*)?)$/.test(normalized);
};

export const isClassAllowed = (
  profile: CollaborationAccessProfile | null | undefined,
  classId: string
): boolean => Boolean(
  profile?.allowed && (
    profile.classScope.kind === 'all' || profile.classScope.classIds.includes(classId)
  )
);

export const canForceRefreshAccess = (
  now: number,
  lastForcedRefreshAt: number | undefined,
  floorMs: number
): boolean => lastForcedRefreshAt === undefined || now - lastForcedRefreshAt >= floorMs;
