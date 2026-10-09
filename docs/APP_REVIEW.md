# Meta App Review: submission guide

This guide is for the person submitting the Instagram app for App Review. It covers what to ask for, why, what to record, and what to provide. Replace every `<placeholder>` before you submit.

## 1. What the app does

Streamers connect their own Instagram Business or Creator accounts. They upload a video, choose a caption and a publish time, and the app publishes the video as a Reel at that time. The app also shows each post's basic performance numbers. It never logs in with a password, and it never likes, follows, or comments on anyone's behalf.

## 2. Permissions to request

Request the three Instagram Login permissions below. Do not request anything else.

| Permission | Why we need it | Where the user sees it |
| --- | --- | --- |
| `instagram_business_basic` | Read the account's ID, username and account type, so we can show which account is connected and reject personal accounts. | Accounts page |
| `instagram_business_content_publish` | Create and publish the Reels the user scheduled. | Schedule page, Dashboard |
| `instagram_business_manage_insights` | Read the views, reach, likes, comments, shares, saves and total interactions for the user's own posts. | Post page (insights) |

Justification text to paste into each permission field:

- **Basic:** "Our users connect their own Instagram professional accounts. We read the account ID, username and account type to show which account is connected and to make sure only Business or Creator accounts are used."
- **Content publish:** "Our users schedule short videos they have made, and the app publishes them as Reels to their own account at the time they chose. Nothing is published without the user's scheduling action."
- **Manage insights:** "After a post is published, the app reads its basic performance numbers for the user's own post, one hour, 24 hours and 7 days after publishing, and shows them to the user on the post page."

## 3. Screencast script

Record one continuous screen capture, about three minutes, at 1080p or higher. Narrate each step. Do not show any real customer data. Use a test account.

1. **Sign in.** Open the app's login page. Enter the reviewer's email. Show the sign-in email arriving and click the link. *Narrate: "The operator signs in with a magic link. No Instagram password is ever stored."*
2. **Connect an account.** Open Accounts and click "Connect an Instagram account". Show the Instagram consent screen listing the three permissions. Approve. Show the account appearing in the list with its username and type. *Narrate: "We only accept Business or Creator accounts."*
3. **Upload.** Open the editor, choose the connected account, and upload a video. Wait for "ready". *Narrate: "The video is converted to the Reel format, and the user can see its length and resolution."*
4. **Schedule.** Pick the video, write a caption, choose a time 30 minutes ahead, and click Schedule. Show the post in the Dashboard's Scheduled list. *Narrate: "The post waits until its publish time."*
5. **Publish.** Wait for the publish time, or use the reviewer test publish. Show the post's status change to published and its permalink open on Instagram. *Narrate: "The Reel is now live on the user's own account."*
6. **Insights.** Open the post page and show the insights list after the first pull. *Narrate: "Only this user's post numbers are shown."*
7. **Disconnect.** In Instagram's app settings, remove the app's access. Show the account in the app change to revoked. *Narrate: "Removing access stops publishing for the account."*
8. **Delete.** Show the privacy page at the public URL below, and say how deletion works.

## 4. URLs to provide

- **Privacy policy:** `https://<your-domain>/privacy`. The page must not be a draft when you submit. Replace its text and its contact address.
- **Data deletion callback:** `https://<your-domain>/api/meta/data-deletion`. It returns a status URL and a confirmation code.
- **Deauthorize callback:** `https://<your-domain>/api/meta/deauthorize`.
- **OAuth redirect:** `https://<your-domain>/api/ig/callback`. The same URL goes in `IG_REDIRECT_URI`.

## 5. Test credentials checklist

Before submitting, prepare these and put them in the App Review notes, not in this repository.

- [ ] A reviewer login for the scheduler: an email address the reviewers can receive mail on, with the sign-in link flow working.
- [ ] An Instagram Business or Creator test account, with its username, added as an Instagram tester on the Meta app.
- [ ] A short video the reviewer can upload (under 60 seconds, 9:16 preferred, with an audio track).
- [ ] The steps from section 3, so the reviewer can repeat them without help.
- [ ] Confirmation that the privacy and deletion URLs open without a login.

## 6. Before you submit

- **Business verification.** Required for Advanced Access. Start it early, because it takes days.
- **Standard access is enough** only for accounts that have a tester role on the app. Other streamers need Advanced Access, which needs this review.
- **Data processing agreement.** Each paying streamer may need one under GDPR. Decide on a template before launch.
- **AI disclosure.** If the app adds AI-generated content later, the handoff's section 10 items apply.
- **Known limits to state honestly in the notes.** Clips are fixed-length windows picked by a scoring rule, not by AI. Insights are pulled at three fixed times, and the app does not store historical data beyond those pulls.

## 7. After review

If Meta asks for changes, update this document, then the code, then resubmit. Keep the screencast in sync with the app's screens. Re-record it after any UI change.
