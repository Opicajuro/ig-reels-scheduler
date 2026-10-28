-- Localirs has no sign-in any more, so the Auth.js tables are dropped. The User row stays as the app's owner.
DROP TABLE "Account";
DROP TABLE "Session";
DROP TABLE "VerificationToken";
