import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";
import { env } from "./env";

export type SessionData = {
  adobe?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    accountId?: string;
    email?: string;
    name?: string;
  };
  oauthState?: {
    state: string;
    codeVerifier: string;
    createdAt: number;
  };
};

function options(): SessionOptions {
  return {
    password: env.sessionPassword(),
    cookieName: "lightroom_dedupe_session",
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    },
  };
}

export async function getSession() {
  const store = await cookies();
  return getIronSession<SessionData>(store, options());
}
