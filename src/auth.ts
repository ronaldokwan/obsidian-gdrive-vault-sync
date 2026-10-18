import { Platform, requestUrl } from "obsidian";

// drive.file only grants access to files this app created, and is a non-sensitive
// scope, so a personal OAuth client can be published without Google verification.
export const SCOPE = "https://www.googleapis.com/auth/drive.file";
export const LOOPBACK_PORT = 43821;
export const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}`;

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface AccessToken {
  accessToken: string;
  expiresAt: number;
}

export interface Tokens extends AccessToken {
  refreshToken: string;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function buildAuthUrl(clientId: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

/** Accepts either the full redirect URL copied from the browser, or just the code. */
export function extractCode(input: string, expectedState: string): string {
  const trimmed = input.trim();
  if (!trimmed.includes("code=")) return trimmed;

  const query = trimmed.slice(trimmed.indexOf("?") + 1);
  const params = new URLSearchParams(query);
  const error = params.get("error");
  if (error) throw new Error(`Google returned an error: ${error}`);
  const state = params.get("state");
  if (state && state !== expectedState) {
    throw new Error("This link is from a different sign-in attempt. Start again.");
  }
  const code = params.get("code");
  if (!code) throw new Error("No code found in the pasted address.");
  return code;
}

async function tokenRequest(params: Record<string, string>) {
  const res = await requestUrl({
    url: TOKEN_ENDPOINT,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams(params).toString(),
    throw: false,
  });
  if (res.status !== 200) {
    let detail = res.text;
    try {
      detail = res.json.error_description ?? res.json.error ?? detail;
    } catch {
      // keep raw text
    }
    throw new Error(`Google token request failed (${res.status}): ${detail}`);
  }
  return res.json;
}

export async function exchangeCode(client: OAuthClient, code: string, verifier: string): Promise<Tokens> {
  const json = await tokenRequest({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  if (!json.refresh_token) {
    throw new Error("Google did not return a refresh token. Remove the app's access in your Google account and sign in again.");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

export async function refreshAccessToken(client: OAuthClient, refreshToken: string): Promise<AccessToken> {
  const json = await tokenRequest({
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: "refresh_token",
  });
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

export interface LoopbackListener {
  code: Promise<string>;
  close: () => void;
}

/**
 * Desktop only: listens on 127.0.0.1 so the browser redirect completes sign-in
 * automatically. Returns null on mobile, where the user pastes the URL instead.
 */
export function listenForLoopbackCode(expectedState: string): LoopbackListener | null {
  if (!Platform.isDesktopApp) return null;

  const http: typeof import("http") = require("http");
  let server: import("http").Server | undefined;

  const code = new Promise<string>((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (!code && !error) {
        res.writeHead(404);
        res.end();
        return;
      }

      const ok = !!code && url.searchParams.get("state") === expectedState;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        ok
          ? "<h2>Signed in to Google Drive Vault Sync.</h2><p>You can close this tab and return to Obsidian.</p>"
          : "<h2>Sign-in failed.</h2><p>Return to Obsidian and try again.</p>"
      );
      server?.close();

      if (ok) resolve(code!);
      else reject(new Error(error ? `Google returned an error: ${error}` : "Sign-in state mismatch."));
    });
    server.on("error", reject);
    server.listen(LOOPBACK_PORT, "127.0.0.1");
  });

  return { code, close: () => server?.close() };
}
