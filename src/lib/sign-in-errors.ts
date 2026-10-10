// Auth.js sends a failed sign-in back to the login page as ?error=<code>. These are the codes an email sign-in can
// produce, in words a person can act on. The exact reason is always in the web app's log.
const MESSAGES: Record<string, string> = {
  Configuration:
    "The sign-in email could not be sent. The exact reason is in data\\web.err.log in the Localirs folder. Usually the Resend API key or sender address is wrong: run Set up Localirs again to enter them.",
  EmailSignin:
    "The sign-in email could not be sent. Check the address and try again; the reason is in data\\web.err.log in the Localirs folder.",
  Verification: "That sign-in link has expired or was already used. Ask for a new one below.",
  AccessDenied: "This address is not allowed to sign in.",
};

const FALLBACK = "Sign-in did not work. The reason is in data\\web.err.log in the Localirs folder. Try again below.";

export function signInErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? FALLBACK;
}
