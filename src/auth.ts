import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  // Errors come back to the login page, which says what went wrong, instead of Auth.js's generic error page.
  pages: { error: "/login" },
  callbacks: {
    session({ session, user }) {
      return { ...session, user: { ...session.user, id: user.id } };
    },
  },
  providers: [
    Resend({
      apiKey: requireEnv("RESEND_API_KEY"),
      from: requireEnv("EMAIL_FROM"),
    }),
  ],
});
