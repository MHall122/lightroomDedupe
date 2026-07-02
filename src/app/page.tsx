import Link from "next/link";
import { getSession } from "@/lib/session";
import { redirect } from "next/navigation";

const ERROR_MESSAGES: Record<string, string> = {
  state_mismatch: "Login state mismatch — please try signing in again.",
  state_expired: "Login timed out — please try signing in again.",
  missing_code_or_state: "Adobe didn't return an authorization code.",
  access_denied: "You cancelled the Adobe sign-in.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (session.adobe) redirect("/dashboard");
  const { error } = await searchParams;
  const message = error ? ERROR_MESSAGES[error] ?? error : null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="max-w-xl w-full flex flex-col items-center text-center gap-6">
        <h1 className="text-4xl font-semibold tracking-tight">
          Find duplicates in your Lightroom cloud.
        </h1>
        <p className="text-lg text-zinc-700">
          Sign in with your Adobe account, scan your cloud library, review
          suspected duplicates side by side, and move the extras to Lightroom's
          trash. Nothing is deleted without your confirmation.
        </p>
        {message && (
          <div className="w-full rounded-md bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm text-left">
            {message}
          </div>
        )}
        <Link
          href="/api/auth/login"
          className="inline-flex items-center gap-2 rounded-full bg-black text-white px-6 py-3 text-base font-medium hover:bg-zinc-800 transition-colors"
        >
          Sign in with Adobe
        </Link>
        <p className="text-xs text-zinc-600 max-w-md">
          This app uses Adobe's Lightroom API to read your photos' thumbnails
          and compare them for duplicates. Photos you choose to remove go to
          Lightroom's trash and can be recovered for 60 days.
        </p>
      </div>
    </main>
  );
}
