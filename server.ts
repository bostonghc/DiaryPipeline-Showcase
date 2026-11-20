
import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as msal from "@azure/msal-node";
import { applicationDefault, getApps as getFirebaseAdminApps, initializeApp as initializeFirebaseAdmin } from "firebase-admin/app";
import { getAuth as getFirebaseAdminAuth } from "firebase-admin/auth";
import { getFirestore as getFirebaseAdminFirestore } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "crypto";
import {
  AI_REVIEW_GEMINI_CONFIG,
  AI_REVIEW_RATE_LIMIT,
  AI_REVIEW_RATE_WINDOW_MS,
  createRateLimiter,
  handleReviewFeedback,
  handleReviewOutcome,
  type AiReviewDeps,
} from "./services/aiReviewServer";
import { buildIdentityClaims, mergeIdentityClaims } from "./services/identityClaims";
import { isGraphPathAllowed } from "./services/graphProxyAllowlist";
import {
  classifyGraphEndpointFamily,
  deriveTelemetryUserKey,
  formatGraphTelemetryLine,
  formatSyncRunTelemetryLine,
  isValidSyncRunId,
  isValidSyncRunOutcome,
  readSyncRunId,
  type GraphRequestOutcome,
} from "./services/graphTelemetry";
import {
  CollaborationAccessProfile,
  CollaborationMembership,
  canForceRefreshAccess,
  isClassScopedGraphPathAllowed,
  readCollaborationConfig,
  resolveCollaborationAccess,
} from "./services/collaborationAccess";
import {
  buildSessionOptions,
  enforceSessionCap,
  keepAliveHandler,
  readSessionLifetimeConfig,
} from "./services/sessionLifetime";

dotenv.config({ path: ".env.local" });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
// OneNote page listings for a large section regularly run past 30s. The old
// limit aborted them mid-flight, which reached the UI as a section that simply
// failed to load. Overridable so a slow tenant can be tuned without a rebuild.
const GRAPH_PROXY_TIMEOUT_MS = Number(process.env.GRAPH_PROXY_TIMEOUT_MS || 90000);
const collaborationConfig = readCollaborationConfig(process.env);
const ACCESS_PROFILE_TTL_MS = 5 * 60 * 1000;
const ACCESS_FORCE_REFRESH_FLOOR_MS = 15 * 1000;

const GRAPH_SCOPES = ["User.Read", "Notes.Read", "Notes.Read.All", "EduRoster.ReadBasic", "User.ReadBasic.All", "Mail.Send", "Chat.Create", "Chat.ReadWrite", "offline_access"];

let pcaInstance: msal.ConfidentialClientApplication | null = null;

const hasMeaningfulEnv = (name: string, placeholder?: string): boolean => {
  const value = process.env[name]?.trim();
  return Boolean(value && value !== placeholder);
};

const getConfiguredHost = (value?: string): string | null => {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return "configured";
  }
};

const readFirebaseConfigStatus = () => {
  const configPath = path.join(__dirname, "firebase-applet-config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return {
      configFilePresent: true,
      projectIdSet: Boolean(config.projectId),
      authDomainSet: Boolean(config.authDomain),
      firestoreDatabaseIdSet: Boolean(config.firestoreDatabaseId),
      projectId: config.projectId || null,
      firestoreDatabaseId: config.firestoreDatabaseId || null,
    };
  } catch {
    return {
      configFilePresent: false,
      projectIdSet: false,
      authDomainSet: false,
      firestoreDatabaseIdSet: false,
      projectId: null,
      firestoreDatabaseId: null,
    };
  }
};

async function getPca(): Promise<msal.ConfidentialClientApplication> {
  if (!pcaInstance) {
    const clientId = (process.env.ENTRA_CLIENT_ID || "placeholder").trim();
    const tenantId = (process.env.ENTRA_TENANT_ID || "common").trim();
    const clientSecret = (process.env.ENTRA_CLIENT_SECRET || "placeholder").trim();

    const msalConfig: msal.Configuration = {
      auth: {
        clientId: clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        clientSecret: clientSecret,
      },
      system: {
        loggerOptions: {
          loggerCallback(loglevel, message, containsPii) {
            if (!containsPii) console.log(message);
          },
          piiLoggingEnabled: false,
          logLevel: msal.LogLevel.Info,
        },
      },
    };
    pcaInstance = new msal.ConfidentialClientApplication(msalConfig);
  }
  return pcaInstance;
}

const getSessionAccount = (req: express.Request): msal.AccountInfo | null =>
  (req.session as any)?.account || null;

const getSessionAccessToken = async (req: express.Request): Promise<string | null> => {
  let accessToken = (req.session as any)?.accessToken || null;
  const account = getSessionAccount(req);

  if (account) {
    try {
      const pca = await getPca();
      const response = await pca.acquireTokenSilent({ account, scopes: GRAPH_SCOPES });
      if (response?.accessToken) {
        accessToken = response.accessToken;
        (req.session as any).accessToken = response.accessToken;
        (req.session as any).account = response.account;
      }
    } catch (error) {
      console.log("Silent token acquisition failed:", error);
    }
  }

  return accessToken;
};

const listMicrosoftMemberships = async (
  accessToken: string,
  userKey?: string,
  syncRunId?: string
): Promise<CollaborationMembership[]> => {
  const memberships: CollaborationMembership[] = [];
  let nextUrl: string | null =
    "https://graph.microsoft.com/v1.0/me/memberOf?$select=id,displayName&$top=100";

  while (nextUrl) {
    // Counted because it bypasses /api/graph/* and would otherwise be invisible
    // Graph traffic. It is NOT OneNote traffic, so it does not count against
    // the documented OneNote per-user budget — see ONENOTE_BUDGET_FAMILIES.
    const startedAt = Date.now();
    const response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30000),
    });
    console.log(formatGraphTelemetryLine({
      family: 'identity',
      method: 'GET',
      status: response.status,
      outcome: 'server',
      upstreamMs: Date.now() - startedAt,
      preflightMs: 0,
      timedOut: false,
      syncRunId,
      userKey,
    }));
    if (!response.ok) {
      throw new Error(`Microsoft membership lookup failed with ${response.status}`);
    }

    const data = await response.json() as {
      value?: CollaborationMembership[];
      '@odata.nextLink'?: string;
    };
    memberships.push(...(data.value || []).filter((item) => Boolean(item?.id)));
    nextUrl = data['@odata.nextLink'] || null;
  }

  return memberships;
};

const getCollaborationAccess = async (
  req: express.Request,
  accessToken?: string | null,
  options: { force?: boolean } = {}
): Promise<CollaborationAccessProfile | null> => {
  const account = getSessionAccount(req);
  if (!account) return null;

  const cached = (req.session as any)?.collaborationAccess as
    | { profile: CollaborationAccessProfile; resolvedAtMs: number; invalidated?: boolean }
    | undefined;
  const now = Date.now();
  const lastForcedRefreshAt = (req.session as any)?.collaborationAccessLastForcedAtMs as number | undefined;
  const forceAllowed = options.force && canForceRefreshAccess(
    now,
    lastForcedRefreshAt,
    ACCESS_FORCE_REFRESH_FLOOR_MS
  );
  if (options.force && !forceAllowed && cached) {
    return cached.profile;
  }
  const forcedRefreshIsCoolingDown = lastForcedRefreshAt !== undefined &&
    !canForceRefreshAccess(now, lastForcedRefreshAt, ACCESS_FORCE_REFRESH_FLOOR_MS);
  if (!forceAllowed && cached && (
    (!cached.invalidated && now - cached.resolvedAtMs < ACCESS_PROFILE_TTL_MS) ||
    (cached.invalidated && forcedRefreshIsCoolingDown)
  )) {
    return cached.profile;
  }
  if (forceAllowed) {
    (req.session as any).collaborationAccessLastForcedAtMs = now;
  }

  const resolvedAt = new Date(now).toISOString();
  let profile = resolveCollaborationAccess(collaborationConfig, account, [], resolvedAt);
  if (collaborationConfig.pilotEnabled && !profile.allowed) {
    const token = accessToken || await getSessionAccessToken(req);
    if (!token) throw new Error("Microsoft session has no access token");
    const memberships = await listMicrosoftMemberships(
      token,
      deriveTelemetryUserKey(account.localAccountId, process.env.SESSION_SECRET),
      // Carried from the proxy request that triggered this access check, so the
      // lookup groups with the run that caused it rather than floating free.
      readSyncRunId(req.headers['x-sync-run-id'])
    );
    profile = resolveCollaborationAccess(collaborationConfig, account, memberships, resolvedAt);
  }

  (req.session as any).collaborationAccess = { profile, resolvedAtMs: now };
  return profile;
};

/**
 * Firebase Admin, for writing identity claims onto Firebase sign-ins. Uses
 * Application Default Credentials: on Cloud Run the runtime service account
 * (granted roles/firebaseauth.admin), locally `gcloud auth application-default
 * login`. No key file — see docs/reference/feedback-attribution-plan.md.
 */
const firebaseAdminAuth = () => {
  if (getFirebaseAdminApps().length === 0) {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, "firebase-applet-config.json"), "utf8"));
    initializeFirebaseAdmin({ credential: applicationDefault(), projectId: config.projectId });
  }
  return getFirebaseAdminAuth();
};

/** The Firebase uid behind an ID token, or null if the token is missing or invalid. */
const verifyFirebaseIdToken = async (idToken: unknown): Promise<string | null> => {
  if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 8192) return null;
  try {
    return (await firebaseAdminAuth().verifyIdToken(idToken)).uid;
  } catch {
    return null;
  }
};

/** Like verifyFirebaseIdToken, but also returns the token's custom claims (ms_* identity). */
const verifyFirebaseIdTokenWithClaims = async (
  idToken: unknown
): Promise<{ uid: string; claims: Record<string, unknown> } | null> => {
  if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 8192) return null;
  try {
    const decoded = await firebaseAdminAuth().verifyIdToken(idToken);
    return { uid: decoded.uid, claims: decoded as unknown as Record<string, unknown> };
  } catch {
    return null;
  }
};

/** Admin Firestore on the app's named database (same ADC credentials as the Auth admin). */
let firebaseAdminFirestoreInstance: ReturnType<typeof getFirebaseAdminFirestore> | null = null;
const firebaseAdminFirestore = () => {
  // Read the config and build the Firestore handle once per process.
  if (!firebaseAdminFirestoreInstance) {
    firebaseAdminAuth(); // ensures the admin app is initialised
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, "firebase-applet-config.json"), "utf8"));
    firebaseAdminFirestoreInstance = getFirebaseAdminFirestore(getFirebaseAdminApps()[0], config.firestoreDatabaseId);
  }
  return firebaseAdminFirestoreInstance;
};

// One limiter for the process. Per-instance development safeguard, not a
// deployment-wide spending ceiling.
const aiReviewAllow = createRateLimiter(AI_REVIEW_RATE_LIMIT, AI_REVIEW_RATE_WINDOW_MS);
const aiReviewApiKey = () => (process.env.GEMINI_API_KEY || process.env.API_KEY || "").trim();

const buildAiReviewDeps = (): AiReviewDeps => ({
  geminiConfigured: aiReviewApiKey().length > 0,
  verifyToken: verifyFirebaseIdTokenWithClaims,
  readDoc: async (docPath) => {
    const snap = await firebaseAdminFirestore().doc(docPath.join("/")).get();
    return snap.exists ? (snap.data() as Record<string, unknown>) : null;
  },
  writeDoc: async (docPath, data) => { await firebaseAdminFirestore().doc(docPath.join("/")).set(data); },
  updateDoc: async (docPath, data) => { await firebaseAdminFirestore().doc(docPath.join("/")).update(data); },
  transact: async (docPath, fn) => {
    const db = firebaseAdminFirestore();
    const ref = db.doc(docPath.join("/"));
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const { update, result } = fn(snap.exists ? (snap.data() as Record<string, unknown>) : null);
      if (update) tx.update(ref, update); // keys are field paths, e.g. "outcomes.c1"
      return result;
    });
  },
  generate: async (model, system, user) => {
    const ai = new GoogleGenAI({ apiKey: aiReviewApiKey() });
    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: user }] }],
      config: { systemInstruction: system, ...AI_REVIEW_GEMINI_CONFIG },
    });
    return response.text ?? "";
  },
  allow: aiReviewAllow,
  newId: () => randomUUID(),
  now: () => new Date().toISOString(),
  log: (line) => console.log(line),
});

const invalidateCollaborationAccess = (req: express.Request): void => {
  const cached = (req.session as any).collaborationAccess as
    | { profile: CollaborationAccessProfile; resolvedAtMs: number; invalidated?: boolean }
    | undefined;
  if (cached) cached.invalidated = true;
};

/**
 * Emit a proxy-generated failure in Microsoft Graph's own error shape.
 *
 * The Graph SDK parses error bodies as `{ error: { code, message } }`
 * (GraphErrorHandler.constructErrorFromResponse). A bare `{ error: "text" }`
 * envelope leaves `error.message` undefined, so every proxy-side failure used
 * to reach the browser with no message at all and surfaced as the useless
 * "Unknown API Error". Keeping this shape means the real cause travels intact.
 */
const sendGraphStyleError = (
  res: express.Response,
  status: number,
  code: string,
  message: string
) => res.status(status).json({ error: { code, message } });

async function startServer() {
  console.log("Starting server initialization...");
  if (!Number.isFinite(PORT) || PORT <= 0) {
    throw new Error("PORT must be a positive number.");
  }
  if (process.env.NODE_ENV === "production" && collaborationConfig.pilotEnabled) {
    if (collaborationConfig.ownerUpns.length === 0) {
      throw new Error("COLLABORATION_OWNER_UPNS is required when the collaboration pilot is enabled.");
    }
    if (collaborationConfig.pilotClassIds.length === 0) {
      throw new Error("COLLABORATION_CLASS_IDS is required when the collaboration pilot is enabled.");
    }
  }
  const app = express();

  // Health check route
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", env: process.env.NODE_ENV });
  });

  app.get("/api/config/status", (_req, res) => {
    res.json({
      runtime: {
        nodeEnv: process.env.NODE_ENV || "development",
        appUrlSet: hasMeaningfulEnv("APP_URL"),
        appUrlHost: getConfiguredHost(process.env.APP_URL),
      },
      entra: {
        clientIdSet: hasMeaningfulEnv("ENTRA_CLIENT_ID", "placeholder"),
        tenantIdSet: hasMeaningfulEnv("ENTRA_TENANT_ID", "common"),
        clientSecretSet: hasMeaningfulEnv("ENTRA_CLIENT_SECRET", "placeholder"),
        tenantIdLabel: process.env.ENTRA_TENANT_ID || "common",
      },
      session: {
        secretSet: hasMeaningfulEnv("SESSION_SECRET", "a-very-secret-key"),
      },
      ai: {
        geminiApiKeySet: hasMeaningfulEnv("GEMINI_API_KEY") || hasMeaningfulEnv("API_KEY"),
      },
      firebase: readFirebaseConfigStatus(),
      collaboration: {
        pilotEnabled: collaborationConfig.pilotEnabled,
        ownerCount: collaborationConfig.ownerUpns.length,
        leadCount: collaborationConfig.leadUpns.length,
        classCount: collaborationConfig.pilotClassIds.length,
      },
    });
  });

  app.use(express.json({
    verify: (req: any, _res: any, buf: Buffer) => {
      // Capture the raw body string before JSON.parse transforms it.
      // The proxy forwards this verbatim so OData annotation keys like
      // user@odata.bind survive the round-trip intact.
      if (req.originalUrl?.startsWith('/api/graph')) {
        req.rawBody = buf.toString('utf8');
      }
    },
  }));
  app.use(cookieParser());
  
  console.log("Configuring session...");
  // Fail fast in production rather than silently signing session cookies with a
  // shared default. The dev fallback below keeps localhost working without config,
  // but a deployed instance must supply a real SESSION_SECRET.
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (process.env.NODE_ENV === "production" &&
      (!sessionSecret || sessionSecret === "a-very-secret-key")) {
    throw new Error(
      "SESSION_SECRET must be set to a strong, unique value in production. " +
      "Refusing to start with the default session secret."
    );
  }
  // Session cookie configuration. `trust proxy` lets Express honor the
  // X-Forwarded-Proto header when running behind Cloud Run or another
  // TLS-terminating reverse proxy so `secure: true` cookies are not
  // dropped on legitimate HTTPS traffic.
  app.set("trust proxy", 1);
  // `secure` must follow the actual transport, not just the browser's opinion of
  // localhost: express-session refuses to emit a Secure cookie when the request
  // is not HTTPS (see its "not secured" guard), so hardcoding `true` silently
  // drops the session cookie in local http://localhost dev. Sign-in then appears
  // to succeed and every later /api/auth/me and /api/graph call is anonymous.
  // Behind Cloud Run, `trust proxy` makes req.secure true from X-Forwarded-Proto,
  // so production still gets a Secure cookie.
  const useSecureCookies = process.env.NODE_ENV === "production";
  // Idle timeout (renewed on every request) plus an absolute cap on one Microsoft
  // sign-in; see services/sessionLifetime.ts.
  const sessionLifetime = readSessionLifetimeConfig(process.env);
  app.use(
    session(
      buildSessionOptions({
        secret: sessionSecret || "a-very-secret-key",
        secure: useSecureCookies,
        idleMs: sessionLifetime.idleMs,
      })
    )
  );
  app.use(enforceSessionCap(sessionLifetime.maxMs));

  // Helper to get dynamic redirect URI
  const getRedirectUri = (req: express.Request) => {
    // Priority 1: Environment variable (most reliable in Cloud Run)
    if (process.env.APP_URL) {
      const url = process.env.APP_URL.endsWith('/') ? process.env.APP_URL.slice(0, -1) : process.env.APP_URL;
      return `${url}/auth/callback`;
    }

    // Priority 2: Request headers
    const forwardedHost = req.headers["x-forwarded-host"];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || req.get("host") || "";
    
    // Entra ID requires HTTPS for all non-localhost redirect URIs.
    // We force https for cloud run domains to avoid mismatch errors.
    const isLocalHost = host.includes("localhost") || host.includes("127.0.0.1");
    const protocol = isLocalHost ? "http" : "https";

    return `${protocol}://${host}/auth/callback`;
  };

  // --- Auth Routes ---

  app.get("/api/auth/url", async (req, res) => {
    const redirectUri = getRedirectUri(req);
    const authCodeUrlParameters = {
      scopes: GRAPH_SCOPES,
      redirectUri: redirectUri,
    };

    try {
      const pca = await getPca();
      const response = await pca.getAuthCodeUrl(authCodeUrlParameters);
      console.log("Generated Auth URL Scopes:", authCodeUrlParameters.scopes);
      console.log("Redirect URI:", authCodeUrlParameters.redirectUri);
      res.json({ url: response });
    } catch (error) {
      console.error("Error generating auth URL:", error);
      res.status(500).json({ error: "Failed to generate auth URL" });
    }
  });

  app.get("/auth/callback", async (req, res) => {
    const redirectUri = getRedirectUri(req);
    const tokenRequest = {
      code: req.query.code as string,
      scopes: GRAPH_SCOPES,
      redirectUri: redirectUri,
    };

    try {
      const pca = await getPca();
      const response = await pca.acquireTokenByCode(tokenRequest);
      if (req.session) {
        (req.session as any).account = response.account;
        (req.session as any).accessToken = response.accessToken;
        (req.session as any).signedInAtMs = Date.now();
        delete (req.session as any).collaborationAccess;
      }
      
      // Send success message to parent window and close popup
      res.send(`
        <html>
          <body>
            <script>
              // This callback page is served by our own origin, so the app window
              // that opened the popup is same-origin. Target that origin explicitly
              // instead of '*' so the access token is never delivered to a window
              // on a different origin (token-theft defense). The receiver in the
              // app additionally validates event.origin.
              var APP_ORIGIN = window.location.origin;
              if (window.opener) {
                window.opener.postMessage({
                  type: 'OAUTH_AUTH_SUCCESS'
                }, APP_ORIGIN);

                // Also try messaging parent if opener fails (fallback)
                if (window.parent !== window) {
                  window.parent.postMessage({
                    type: 'OAUTH_AUTH_SUCCESS'
                  }, APP_ORIGIN);
                }

                setTimeout(() => window.close(), 500);
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful. This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (error: any) {
      const details = error?.errorMessage || error?.message || "Unknown error";
      console.error("Error acquiring token:", details, error);
      res.status(500).send(`Authentication failed: ${details}`);
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    const account = getSessionAccount(req);
    if (!account) return res.status(401).json({ error: "Not authenticated" });

    try {
      const access = await getCollaborationAccess(req, null, {
        force: req.query.refresh === 'force',
      });
      if (access?.pilotEnabled && !access.allowed) {
        return res.status(403).json({ error: "not_assigned", account, access });
      }
      res.json({ account, access, aiReview: { configured: aiReviewApiKey().length > 0 } });
    } catch (error) {
      console.error("Could not resolve collaboration access:", error);
      res.status(503).json({ error: "access_check_failed" });
    }
  });

  // The browser's activity ping. Kept apart from /api/auth/me on purpose: that
  // route can trigger a Graph membership lookup, this one never touches Microsoft.
  app.post("/api/auth/keepalive", keepAliveHandler);

  // AI feedback review. Thin adapters: all checks live in services/aiReviewServer.ts.
  const aiReviewRoute = (
    handler: (a: CollaborationAccessProfile | null, b: unknown, d: AiReviewDeps) => Promise<{ status: number; body: unknown }>
  ): express.RequestHandler => async (req, res) => {
    try {
      const account = getSessionAccount(req);
      let access: CollaborationAccessProfile | null = null;
      if (account) {
        try {
          access = await getCollaborationAccess(req);
        } catch (error) {
          console.error("[gemini:feedback-review] status=503 error=access_check_failed");
          return res.status(503).json({ error: "access_check_failed", message: "Could not check your access. Try again." });
        }
      }
      const result = await handler(access, req.body, buildAiReviewDeps());
      res.status(result.status).json(result.body);
    } catch (error: any) {
      console.error(`[gemini:feedback-review] status=500 error=unhandled ${error?.code ?? ""}`);
      res.status(500).json({ error: "server_error", message: "AI review failed unexpectedly." });
    }
  };
  app.post("/api/ai/review-feedback", aiReviewRoute(handleReviewFeedback));
  app.post("/api/ai/review-feedback/outcome", aiReviewRoute(handleReviewOutcome));

  app.get("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" });
      }
      res.json({ status: "ok" });
    });
  });

  // Diagnostic route. Exposes config presence, tenant ID, and requested scopes —
  // useful in local dev, but information disclosure if reachable in production.
  // Disabled outside development; /api/config/status already covers the booleans
  // a deployed admin needs.
  app.get("/api/auth/diag", (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({
      clientIdSet: !!process.env.ENTRA_CLIENT_ID,
      tenantIdSet: !!process.env.ENTRA_TENANT_ID,
      secretSet: !!process.env.ENTRA_CLIENT_SECRET,
      tenantId: process.env.ENTRA_TENANT_ID || "common",
      nodeEnv: process.env.NODE_ENV,
      scopes: GRAPH_SCOPES,
      timestamp: new Date().toISOString()
    });
  });

  // Sync-run outcome. Without it, a run that died after three requests reads as
  // a very cheap successful sync when counting requests per syncRunId — the
  // exact misreading that would make the pilot's budget look safe.
  // Identity binding (Track B, ARCHITECTURE §46). The browser sends only its
  // Firebase ID token. Who the user is in Microsoft, and their role and class
  // scope, come from this server's own session — never from the request — and
  // are written onto the Firebase sign-in as custom claims, so Firestore rules
  // can attest authorship and scope reads.
  app.post("/api/auth/firebase-binding", async (req, res) => {
    const account = getSessionAccount(req);
    if (!account) return res.status(401).json({ error: "not_authenticated" });
    const uid = await verifyFirebaseIdToken(req.body?.idToken);
    if (!uid) return res.status(401).json({ error: "invalid_firebase_token" });

    try {
      const access = await getCollaborationAccess(req);
      const claims = access ? buildIdentityClaims(access, new Date().toISOString()) : null;
      if (!claims) return res.status(403).json({ error: "not_assigned" });
      const auth = firebaseAdminAuth();
      const user = await auth.getUser(uid);
      await auth.setCustomUserClaims(uid, mergeIdentityClaims(user.customClaims, claims));
      res.json({ claims });
    } catch (error) {
      console.error("Firebase identity binding failed:", error instanceof Error ? error.message : error);
      res.status(503).json({ error: "binding_failed" });
    }
  });

  // Unbinding needs no Microsoft session: it runs during sign-out, and it can
  // only remove the caller's own identity claims.
  app.delete("/api/auth/firebase-binding", async (req, res) => {
    const uid = await verifyFirebaseIdToken(req.body?.idToken);
    if (!uid) return res.status(401).json({ error: "invalid_firebase_token" });
    try {
      const auth = firebaseAdminAuth();
      const user = await auth.getUser(uid);
      await auth.setCustomUserClaims(uid, mergeIdentityClaims(user.customClaims, null));
      res.json({ ok: true });
    } catch (error) {
      console.error("Firebase identity unbinding failed:", error instanceof Error ? error.message : error);
      res.status(503).json({ error: "unbinding_failed" });
    }
  });

  app.post("/api/telemetry/sync-run", (req, res) => {
    const account = getSessionAccount(req);
    if (!account) return res.status(401).json({ error: "Not authenticated" });

    const { syncRunId, outcome, classCount } = req.body || {};
    if (!isValidSyncRunId(syncRunId) || !isValidSyncRunOutcome(outcome)) {
      return res.status(400).json({ error: "Invalid sync run telemetry" });
    }

    console.log(formatSyncRunTelemetryLine({
      syncRunId,
      outcome,
      classCount: Number.isFinite(classCount) ? Number(classCount) : undefined,
      userKey: deriveTelemetryUserKey(account.localAccountId, process.env.SESSION_SECRET),
    }));
    res.json({ status: "ok" });
  });

  // --- Graph Proxy Route ---
  // This allows the frontend to call Graph API through the backend using the stored token
  app.all("/api/graph/*", async (req, res) => {
    const requestReceivedAt = Date.now();
    // No raw-path logging. The path carries class ids, page ids and
    // continuation tokens, which would contradict the telemetry privacy
    // contract; the structured graph_request event below carries the endpoint
    // family, method and status instead.

    // Telemetry context is built at route entry, not just before the upstream
    // call: a request refused by the allowlist or an access check spends no
    // Graph budget, but a storm of refusals is exactly the kind of thing the
    // canary needs to see rather than have silently dropped.
    const telemetryBase = {
      family: classifyGraphEndpointFamily(req.params[0]),
      method: req.method,
      syncRunId: readSyncRunId(req.headers['x-sync-run-id']),
      userKey: deriveTelemetryUserKey(
        getSessionAccount(req)?.localAccountId,
        process.env.SESSION_SECRET
      ),
    };
    let upstreamStartedAt = 0;
    const logGraphTelemetry = (
      status: number,
      outcome: GraphRequestOutcome,
      timedOut = false
    ) => {
      console.log(formatGraphTelemetryLine({
        ...telemetryBase,
        status,
        outcome,
        timedOut,
        upstreamMs: upstreamStartedAt ? Date.now() - upstreamStartedAt : 0,
        preflightMs: Math.max(0, (upstreamStartedAt || Date.now()) - requestReceivedAt),
      }));
    };

    if (!isGraphPathAllowed(req.method, req.params[0])) {
      console.log(`[Graph proxy] 403 — path/method not in allowlist`);
      logGraphTelemetry(403, 'rejected');
      return sendGraphStyleError(res, 403, "proxy_path_not_allowed", "Graph path not permitted by proxy allowlist.");
    }

    let accessToken = await getSessionAccessToken(req);

    if (!accessToken) {
      console.log("[Graph proxy] 401 — no token in session");
      logGraphTelemetry(401, 'rejected');
      return sendGraphStyleError(res, 401, "not_authenticated", "No Microsoft session on the server. Please sign in again.");
    }

    try {
      const access = await getCollaborationAccess(req, accessToken);
      if (!access?.allowed || !isClassScopedGraphPathAllowed(access, req.params[0])) {
        console.log("[Graph proxy] 403 — collaborator is not assigned to this class or action");
        logGraphTelemetry(403, 'rejected');
        return sendGraphStyleError(res, 403, "class_not_permitted", "Class or action not permitted for this account.");
      }
    } catch (error) {
      console.error("Graph proxy access check failed:", error);
      logGraphTelemetry(503, 'rejected');
      return sendGraphStyleError(res, 503, "access_check_failed", "Could not verify collaborator access.");
    }

    // A valid Graph access token is a JWT: three base64url segments separated by dots.
    // Forwarding a non-JWT (e.g. stale opaque token) produces a cryptic IDX14100 error from
    // Microsoft's token validator. Catch it here and return a clean 401 instead.
    if (accessToken.split('.').length !== 3) {
      console.log("Graph proxy: rejected non-JWT token, returning 401 session_expired");
      logGraphTelemetry(401, 'rejected');
      return sendGraphStyleError(res, 401, "session_expired", "Your session has expired. Please sign in again.");
    }

    const graphUrl = `https://graph.microsoft.com/v1.0/${req.params[0]}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;

    upstreamStartedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GRAPH_PROXY_TIMEOUT_MS);
    try {

      const rawBody: string | undefined = (req as any).rawBody;
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && rawBody && rawBody.length > 0;
      const response = await fetch(graphUrl, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: rawBody } : {}),
        signal: controller.signal
      });

      if (!response.ok) {
        // Graph's own errors are already { error: { code, message } } and are
        // forwarded verbatim. A non-JSON body (throttling and 5xx sometimes
        // return HTML or nothing) is normalized into the same shape so the
        // status still reaches the client instead of being erased.
        const rawErrorBody = await response.text();
        let errorData: Record<string, unknown>;
        try {
          const parsed = JSON.parse(rawErrorBody);
          errorData = parsed && typeof parsed.error === 'object' && parsed.error !== null
            ? parsed
            : {
                error: {
                  code: `graph_error_${response.status}`,
                  message: typeof parsed?.error === 'string'
                    ? parsed.error
                    : `Microsoft Graph returned ${response.status}.`,
                },
              };
        } catch {
          errorData = {
            error: {
              code: `graph_error_${response.status}`,
              message: `Microsoft Graph returned ${response.status} with a non-JSON body${
                rawErrorBody ? `: ${rawErrorBody.slice(0, 200)}` : '.'
              }`,
            },
          };
        }
        // Status and error code only: a Graph error body can echo the resource
        // path, and the code is what identified the transient OneNote failures.
        console.error(
          `Graph API error (${response.status}):`,
          (errorData as any)?.error?.code ?? 'unknown_code'
        );
        if (response.status === 403) {
          invalidateCollaborationAccess(req);
        }
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        logGraphTelemetry(response.status, 'upstream');
        return res.status(response.status).json({
          ...errorData,
          ...(response.status === 403 ? { collaborationRefreshSuggested: true } : {}),
        });
      }

      // Handle different content types (e.g., HTML for OneNote pages)
      const contentType = response.headers.get("content-type");
      if (contentType) {
        res.setHeader("Content-Type", contentType);
      }

      if (contentType && contentType.includes("application/json")) {
        const data = await response.json();
        logGraphTelemetry(response.status, 'upstream');
        res.json(data);
      } else {
        const data = await response.text();
        logGraphTelemetry(response.status, 'upstream');
        res.send(data);
      }
    } catch (error: any) {
      // AbortError here means our own timeout fired, not a Graph failure. It was
      // previously reported as a generic 500 with no message, which is what made
      // slow OneNote section listings look like broken sections.
      const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
      console.error(`Graph proxy error${timedOut ? ' (timeout)' : ''}:`, error);
      logGraphTelemetry(timedOut ? 504 : 502, 'upstream', timedOut);
      if (timedOut) {
        return sendGraphStyleError(
          res,
          504,
          "proxy_timeout",
          `Microsoft Graph did not respond within ${Math.round(GRAPH_PROXY_TIMEOUT_MS / 1000)}s.`
        );
      }
      return sendGraphStyleError(
        res,
        502,
        "proxy_request_failed",
        `Could not reach Microsoft Graph: ${error?.message || 'unknown network error'}.`
      );
    } finally {
      // In a finally block, not after a successful fetch: a failed upstream
      // request otherwise leaves a 90-second timer alive behind it.
      clearTimeout(timeoutId);
    }
  });

  // --- Vite Middleware for Development ---
  if (process.env.NODE_ENV !== "production") {
    console.log("Initializing Vite middleware...");
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite middleware initialized.");
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at ${process.env.APP_URL || `http://localhost:${PORT}`}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
