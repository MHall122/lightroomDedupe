import { randomBytes, createHash } from "node:crypto";
import { env } from "./env";

export const ADOBE_IMS_BASE = "https://ims-na1.adobelogin.com";
export const ADOBE_SCOPES = [
  "openid",
  "AdobeID",
  "offline_access",
  "lr_partner_apis",
  "lr_partner_rendition_apis",
];

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generatePkce() {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(
    createHash("sha256").update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return base64Url(randomBytes(16));
}

export function buildAuthorizeUrl(params: {
  state: string;
  codeChallenge: string;
}) {
  const url = new URL(`${ADOBE_IMS_BASE}/ims/authorize/v2`);
  url.searchParams.set("client_id", env.adobeClientId());
  url.searchParams.set("redirect_uri", env.adobeRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ADOBE_SCOPES.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type AdobeTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
  scope?: string;
};

export async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
}): Promise<AdobeTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.adobeClientId(),
    client_secret: env.adobeClientSecret(),
    code: params.code,
    code_verifier: params.codeVerifier,
  });
  const res = await fetch(`${ADOBE_IMS_BASE}/ims/token/v3`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Adobe token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as AdobeTokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<AdobeTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.adobeClientId(),
    client_secret: env.adobeClientSecret(),
    refresh_token: refreshToken,
  });
  const res = await fetch(`${ADOBE_IMS_BASE}/ims/token/v3`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Adobe token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as AdobeTokenResponse;
}

type IdTokenPayload = {
  sub?: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
};

export function decodeIdToken(idToken: string): IdTokenPayload | null {
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1] + "===".slice((parts[1].length + 3) % 4);
    const json = Buffer.from(
      padded.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    return JSON.parse(json) as IdTokenPayload;
  } catch {
    return null;
  }
}
