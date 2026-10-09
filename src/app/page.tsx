import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { auth, signOut } from "@/auth";

async function SignedInHome() {
  await connection();
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <main>
      <h1>Signed in as {session.user.email}</h1>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
      >
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<main>Loading…</main>}>
      <SignedInHome />
    </Suspense>
  );
}
