import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { decodeIdToken, exchangeCodeForTokens } from "@/lib/adobe-auth";

function errorRedirect(req: NextRequest, message: string) {
  const url = new URL("/", req.url);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const err = params.get("error");
  if (err) return errorRedirect(req, err);
  if (!code || !state) return errorRedirect(req, "missing_code_or_state");

  const session = await getSession();
  const pending = session.oauthState;
  if (!pending || pending.state !== state) {
    return errorRedirect(req, "state_mismatch");
  }
  if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
    return errorRedirect(req, "state_expired");
  }

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      codeVerifier: pending.codeVerifier,
    });
    const idPayload = tokens.id_token ? decodeIdToken(tokens.id_token) : null;

    session.oauthState = undefined;
    session.adobe = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? "",
      expiresAt: Date.now() + tokens.expires_in * 1000,
      accountId: idPayload?.sub,
      email: idPayload?.email,
      name:
        idPayload?.name ??
        ([idPayload?.given_name, idPayload?.family_name]
          .filter(Boolean)
          .join(" ") ||
          undefined),
    };
    await session.save();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "token_exchange_failed";
    return errorRedirect(req, msg);
  }

  return NextResponse.redirect(new URL("/dashboard", req.url));
}
