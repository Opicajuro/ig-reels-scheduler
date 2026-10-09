# Blocked on human steps

- **M4 manual check:** connect a real Business or Creator test account through /api/ig/connect and confirm it appears on /accounts. Needs a Meta app with IG_APP_ID, IG_APP_SECRET, and IG_REDIRECT_URI set, and the test account added as an Instagram tester (handoff 4.1).
- **M2 manual check:** send a real login email. Needs RESEND_API_KEY and EMAIL_FROM in .env.
- **M1 manual check:** run `docker compose up` on a machine with Docker.
