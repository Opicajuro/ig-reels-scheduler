import { signIn } from "@/auth";

export default function LoginPage() {
  async function sendSignInLink(formData: FormData) {
    "use server";
    await signIn("resend", { email: String(formData.get("email")), redirectTo: "/" });
  }

  return (
    <main>
      <h1>Sign in</h1>
      <form action={sendSignInLink}>
        <input name="email" type="email" required placeholder="you@example.com" />
        <button type="submit">Email me a sign-in link</button>
      </form>
    </main>
  );
}
