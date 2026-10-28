import { UserError } from "./user-error";

// What every form action returns: a short success message for a toast, or a mistake to show next to the form.
// null is the state before the form is first sent.
export type ActionResult = { ok: true; message: string } | { ok: false; error: string } | null;

// Runs a form action's work. A UserError becomes the form's error; anything else, including redirect(), is rethrown.
export async function runAction(work: () => Promise<string>): Promise<ActionResult> {
  try {
    return { ok: true, message: await work() };
  } catch (err) {
    if (err instanceof UserError) return { ok: false, error: err.message };
    throw err;
  }
}
