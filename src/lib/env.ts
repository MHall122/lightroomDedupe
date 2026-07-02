function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}. Copy .env.local.example to .env.local and fill it in.`
    );
  }
  return value;
}

export const env = {
  adobeClientId: () => required("ADOBE_CLIENT_ID"),
  adobeClientSecret: () => required("ADOBE_CLIENT_SECRET"),
  adobeRedirectUri: () =>
    process.env.ADOBE_REDIRECT_URI ?? "http://localhost:3000/api/auth/callback",
  sessionPassword: () => required("SESSION_PASSWORD"),
};
