import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  buildAuthorizeUrl,
  generatePkce,
  generateState,
} from "@/lib/adobe-auth";

export async function GET() {
  const session = await getSession();
  const state = generateState();
  const { codeVerifier, codeChallenge } = generatePkce();
  session.oauthState = { state, codeVerifier, createdAt: Date.now() };
  await session.save();
  const url = buildAuthorizeUrl({ state, codeChallenge });
  return NextResponse.redirect(url);
}
