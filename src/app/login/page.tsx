import { Suspense } from "react";
import { signIn } from "@/auth";
import { signInErrorMessage } from "@/lib/sign-in-errors";

async function SignInError({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const message = signInErrorMessage(Array.isArray(error) ? error[0] : error);
  return message ? <p role="alert">{message}</p> : null;
}

export default function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  async function sendSignInLink(formData: FormData) {
    "use server";
    await signIn("resend", { email: String(formData.get("email")), redirectTo: "/" });
  }

  return (
    <main className="login">
      <p className="brand">
        <span className="brand-mark" aria-hidden="true" />
        Localirs
      </p>
      <h1>Sign in</h1>
      <p className="tagline">We will email you a link. No password needed.</p>
      {/* A failed sign-in comes back here as ?error=..., set by pages.error in src/auth.ts. */}
      <Suspense fallback={null}>
        <SignInError searchParams={searchParams} />
      </Suspense>
      <form action={sendSignInLink}>
        <input name="email" aria-label="Email" type="email" required placeholder="you@example.com" />
        <button type="submit">Email me a sign-in link</button>
      </form>
    </main>
  );
}
