
import express from "express";
import { createServer } from "vite";
import session from "express-session";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as msal from "@azure/msal-node";
import { isGraphPathAllowed } from "./services/graphProxyAllowlist";

dotenv.config({ path: ".env.local" });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

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

async function startServer() {
  console.log("Starting server initialization...");
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
  app.use(
    session({
      secret: sessionSecret || "a-very-secret-key",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: true, // HTTPS only; localhost is treated as secure by browsers
        sameSite: "lax", // CSRF defense: cookie not sent in third-party contexts
        httpOnly: true,
        maxAge: 3600000, // 1 hour
      },
    })
  );

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
                  type: 'OAUTH_AUTH_SUCCESS',
                  account: ${JSON.stringify(response.account)},
                  accessToken: ${JSON.stringify(response.accessToken)}
                }, APP_ORIGIN);

                // Also try messaging parent if opener fails (fallback)
                if (window.parent !== window) {
                  window.parent.postMessage({
                    type: 'OAUTH_AUTH_SUCCESS',
                    account: ${JSON.stringify(response.account)},
                    accessToken: ${JSON.stringify(response.accessToken)}
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

  app.get("/api/auth/me", (req, res) => {
    if (req.session && (req.session as any).account) {
      res.json({ 
        account: (req.session as any).account,
        accessToken: (req.session as any).accessToken
      });
    } else {
      res.status(401).json({ error: "Not authenticated" });
    }
  });

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

  // --- Graph Proxy Route ---
  // This allows the frontend to call Graph API through the backend using the stored token
  app.all("/api/graph/*", async (req, res) => {
    console.log(`[Graph proxy] ${req.method} /api/graph/${req.params[0]}`);

    if (!isGraphPathAllowed(req.method, req.params[0])) {
      console.log(`[Graph proxy] 403 — path/method not in allowlist`);
      return res.status(403).json({ error: "Graph path not permitted by proxy allowlist" });
    }

    let accessToken = (req.session as any)?.accessToken || req.headers.authorization?.split(" ")[1];
    const account = (req.session as any)?.account;

    if (!accessToken) {
      console.log("[Graph proxy] 401 — no token in session or Authorization header");
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Attempt silent refresh if we have an account in session
    if (account) {
      try {
        const pca = await getPca();
        const silentRequest = {
          account: account,
          scopes: GRAPH_SCOPES,
        };
        const response = await pca.acquireTokenSilent(silentRequest);
        if (response && response.accessToken) {
          accessToken = response.accessToken;
          // Persist refreshed token/account values back into session
          (req.session as any).accessToken = response.accessToken;
          (req.session as any).account = response.account;
        }
      } catch (error) {
        console.log("Silent token acquisition failed:", error);
      }
    }

    // A valid Graph access token is a JWT: three base64url segments separated by dots.
    // Forwarding a non-JWT (e.g. stale opaque token) produces a cryptic IDX14100 error from
    // Microsoft's token validator. Catch it here and return a clean 401 instead.
    if (accessToken.split('.').length !== 3) {
      console.log("Graph proxy: rejected non-JWT token, returning 401 session_expired");
      return res.status(401).json({ error: "session_expired", message: "Your session has expired. Please sign in again." });
    }

    const graphUrl = `https://graph.microsoft.com/v1.0/${req.params[0]}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

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

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Unknown Graph error" }));
        console.error(`Graph API error (${response.status}):`, errorData);
        return res.status(response.status).json(errorData);
      }

      // Handle different content types (e.g., HTML for OneNote pages)
      const contentType = response.headers.get("content-type");
      if (contentType) {
        res.setHeader("Content-Type", contentType);
      }

      if (contentType && contentType.includes("application/json")) {
        const data = await response.json();
        res.json(data);
      } else {
        const data = await response.text();
        res.send(data);
      }
    } catch (error) {
      console.error("Graph proxy error:", error);
      res.status(500).json({ error: "Failed to proxy Graph request" });
    }
  });

  // --- Vite Middleware for Development ---
  if (process.env.NODE_ENV !== "production") {
    console.log("Initializing Vite middleware...");
    const vite = await createServer({
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
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
