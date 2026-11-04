// A mistake the person can fix, such as a publish time in the past or a missing name. A server action returns its
// message next to the form; any other error is a bug and still throws to the error page. A link, when given, goes to
// the page where it is fixed.
export class UserError extends Error {
  name = "UserError";

  constructor(
    message: string,
    readonly link?: { href: string; label: string },
  ) {
    super(message);
  }
}
