/**
 * Integ-API OAuth2 Setup
 * ======================
 *
 * Interactive OAuth2 setup flow for Google services.
 *
 * Flow:
 * 1. Generate authorization URL with requested scopes
 * 2. Open the URL in the default browser (or print it for the user)
 * 3. Start a local HTTP server to receive the OAuth2 callback
 * 4. Exchange authorization code for tokens
 * 5. Save credentials via credential store
 *
 * Google OAuth2 authorization endpoint docs:
 * https://developers.google.com/identity/protocols/oauth2/web-server#creatingclient
 *
 * Used by: pa integapi auth google
 */

import * as http from "node:http";
import { createLogger } from "../../core/logger.js";
import type { CredentialStore } from "./store.js";
import type { OAuth2Credentials } from "./manager.js";

const log = createLogger("integ-api:auth:oauth-setup");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default callback port for the local OAuth redirect server. */
const DEFAULT_CALLBACK_PORT = 19101;

/** Google OAuth2 authorization endpoint. */
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google OAuth2 token exchange endpoint. */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoogleOAuthSetupOptions {
  /** OAuth2 client ID from Google Cloud Console. */
  clientId: string;
  /** OAuth2 client secret from Google Cloud Console. */
  clientSecret: string;
  /** OAuth2 scopes to request (e.g. ['https://www.googleapis.com/auth/gmail.readonly']). */
  scopes: string[];
  /** Profile ID to save credentials under. */
  profileId: string;
  /** Local port for the OAuth2 callback server. Default: 19101. */
  callbackPort?: number;
}

export interface OAuthSetupResult {
  profileId: string;
  credentials: OAuth2Credentials;
}

// ---------------------------------------------------------------------------
// Token exchange response type
// ---------------------------------------------------------------------------

interface TokenExchangeResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

// ---------------------------------------------------------------------------
// generateAuthUrl
// ---------------------------------------------------------------------------

/**
 * Generate a Google OAuth2 authorization URL.
 *
 * @param clientId - OAuth2 client ID
 * @param scopes - Scopes to request
 * @param redirectUri - The local redirect URI
 * @param state - CSRF state parameter
 */
export function generateAuthUrl(
  clientId: string,
  scopes: string[],
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent", // force refresh_token to always be returned
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// exchangeCodeForTokens
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for OAuth2 tokens.
 *
 * POST https://oauth2.googleapis.com/token
 */
async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<TokenExchangeResponse> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(unreadable)");
    throw new Error(`Token exchange failed: HTTP ${response.status} — ${errorText}`);
  }

  const data = (await response.json()) as TokenExchangeResponse;
  if (!data.access_token) {
    throw new Error("Token exchange response missing access_token");
  }

  return data;
}

// ---------------------------------------------------------------------------
// runGoogleOAuthSetup
// ---------------------------------------------------------------------------

/**
 * Run an interactive OAuth2 setup flow for Google services.
 *
 * Starts a local HTTP server, generates the auth URL, waits for the browser
 * callback, exchanges the code, and persists credentials via the store.
 *
 * @param options - OAuth setup configuration
 * @param store - Credential store to persist the resulting tokens
 * @param openBrowser - Optional function to open URL (injected for testability)
 * @returns The saved credentials
 */
export async function runGoogleOAuthSetup(
  options: GoogleOAuthSetupOptions,
  store: CredentialStore,
  openBrowser?: (url: string) => void,
): Promise<OAuthSetupResult> {
  const port = options.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const redirectUri = `http://localhost:${port}/oauth/callback`;

  // CSRF state
  const state = Math.random().toString(36).slice(2);

  const authUrl = generateAuthUrl(options.clientId, options.scopes, redirectUri, state);

  log.info({ profileId: options.profileId, scopes: options.scopes }, "Starting OAuth2 setup flow");

  // Print the auth URL for the user
  console.log("\n=== OAuth2 Authorization Required ===");
  console.log(`Profile: ${options.profileId}`);
  console.log(`\nPlease open this URL in your browser:\n\n  ${authUrl}\n`);

  if (openBrowser) {
    openBrowser(authUrl);
  }

  // Start a local server to receive the callback
  const credentials = await waitForCallback(
    port,
    state,
    redirectUri,
    options.clientId,
    options.clientSecret,
  );

  // Save to store
  await store.saveCredentials(options.profileId, credentials);

  log.info({ profileId: options.profileId }, "OAuth2 setup complete, credentials saved");
  console.log(`\n✓ Authorization successful. Credentials saved for profile: ${options.profileId}\n`);

  return { profileId: options.profileId, credentials };
}

// ---------------------------------------------------------------------------
// waitForCallback
// ---------------------------------------------------------------------------

/**
 * Start a local HTTP server and wait for the OAuth2 redirect callback.
 * Resolves with OAuth2Credentials on success; rejects on error or timeout.
 */
async function waitForCallback(
  port: number,
  expectedState: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<OAuth2Credentials> {
  return new Promise<OAuth2Credentials>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const errorParam = url.searchParams.get("error");
      if (errorParam) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<h1>Authorization Failed</h1><p>Error: ${errorParam}</p>` +
            `<p>You can close this tab.</p>`,
        );
        server.close();
        reject(new Error(`OAuth2 authorization denied: ${errorParam}`));
        return;
      }

      const returnedState = url.searchParams.get("state");
      if (returnedState !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Invalid state</h1><p>CSRF check failed. You can close this tab.</p>");
        server.close();
        reject(new Error("OAuth2 CSRF state mismatch"));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>No authorization code</h1><p>You can close this tab.</p>");
        server.close();
        reject(new Error("No authorization code in OAuth2 callback"));
        return;
      }

      try {
        const tokenData = await exchangeCodeForTokens(clientId, clientSecret, code, redirectUri);

        if (!tokenData.refresh_token) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            "<h1>No refresh token</h1>" +
              "<p>No refresh_token was returned. Ensure the app is authorized with access_type=offline " +
              "and prompt=consent.</p><p>You can close this tab.</p>",
          );
          server.close();
          reject(new Error("OAuth2 token exchange returned no refresh_token"));
          return;
        }

        const credentials: OAuth2Credentials = {
          clientId,
          clientSecret,
          refreshToken: tokenData.refresh_token,
          accessToken: tokenData.access_token,
          expiresAt: Date.now() + tokenData.expires_in * 1000,
        };

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Authorization Successful!</h1>" +
            "<p>Your credentials have been saved. You can close this tab.</p>",
        );
        server.close();
        resolve(credentials);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h1>Token Exchange Failed</h1><p>${String(err)}</p><p>You can close this tab.</p>`);
        server.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    server.listen(port, "127.0.0.1", () => {
      log.debug({ port }, "OAuth2 callback server listening");
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start OAuth2 callback server on port ${port}: ${String(err)}`));
    });

    // 5 minute timeout
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth2 authorization timed out after 5 minutes"));
    }, 5 * 60 * 1000);
    timeout.unref();
  });
}
