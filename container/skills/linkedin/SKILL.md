---
name: linkedin
description: Browse LinkedIn — login, read feed, check messages, look up profiles, accept pending invitations. Use whenever the user asks about LinkedIn content.
allowed-tools: Bash(agent-browser:*)
---

# LinkedIn with agent-browser

Use this skill when the user wants to log into LinkedIn, read their feed, check messages, look up profiles, accept pending invitations, or set up a daily feed summary. All workflows use `agent-browser` with persistent session state stored in the group workspace.

## Session state

- **Path:** `/workspace/group/linkedin-auth.json`
- **Save after login:** `agent-browser state save linkedin-auth.json`
- **Load before any LinkedIn task:** open with state in one command, e.g. `agent-browser --state linkedin-auth.json open https://www.linkedin.com/feed`
- **Session expiry:** If after opening with saved state you are redirected to a login page, tell the user the session expired and they need to log in again.

---

## 1. Login and persist session

When the user asks to log into LinkedIn or set up LinkedIn access:

1. Open the login page: `agent-browser open https://www.linkedin.com/login`
2. Take a snapshot: `agent-browser snapshot -i`
3. Identify the email/username and password fields (refs like `@e1`, `@e2`) and the sign-in button
4. Ask the user for their LinkedIn email and password if they did not provide them in the message
5. Fill the form: `agent-browser fill @e1 "user@example.com"` and `agent-browser fill @e2 "password"`
6. Click sign-in: `agent-browser click @e3` (use the ref for the submit button from the snapshot)
7. Wait for navigation: `agent-browser wait --url "**/feed"` or `agent-browser wait 3000`
8. If LinkedIn shows 2FA or verification:
   - Take a screenshot: `agent-browser screenshot linkedin-2fa.png`
   - Tell the user what you see and ask for the code
   - Fill the code field and submit
   - Wait for the feed or home to load
9. Once you see the feed or home (not the login page), save state: `agent-browser state save linkedin-auth.json`
10. Confirm to the user: "Logged into LinkedIn. Session saved so you won't need to log in again for feed summaries and message checks."
11. If the user asked for a daily feed summary, create the scheduled task (see "Daily feed summary" below).

---

## 2. Daily feed summary (scheduled task)

Used when the user wants a daily LinkedIn feed digest, or when a scheduled task runs.

### One-time setup (during or after login)

Create a recurring task so the feed summary runs daily:

- Use the **schedule_task** tool with:
  - **schedule_type:** `cron`
  - **schedule_value:** User's preferred time, e.g. `0 8 * * *` (8:00 AM daily, local timezone)
  - **context_mode:** `isolated`
  - **prompt:** Use the "Daily run prompt" below

If the tool is not available, write a JSON file to `/workspace/ipc/tasks/`:

```bash
# Replace TARGET_JID with the chat JID that should receive the summary (e.g. from conversation context or available_groups.json)
echo '{"type":"schedule_task","prompt":"...","schedule_type":"cron","schedule_value":"0 8 * * *","context_mode":"isolated","targetJid":"TARGET_JID"}' > /workspace/ipc/tasks/linkedin-daily-$(date +%s).json
```

### Daily run prompt (use this as the task prompt)

Copy this into the scheduled task prompt so each run knows what to do:

```
Close any stale browser, then open feed with saved state in one step: run `agent-browser close` then `agent-browser --state linkedin-auth.json open https://www.linkedin.com/feed`. If you are redirected to a login page, send a single message: "LinkedIn session expired — please ask me to log in again." and stop. Otherwise, scroll through the feed: run `agent-browser scroll down 600` then `agent-browser snapshot -i` repeatedly, 5-8 times, to collect visible posts. Extract the text of the main posts (ignore "Promoted" and heavy ads). Summarize the feed into a short digest: key highlights, interesting discussions, and notable updates. Send that summary as your reply to the user. Keep the summary concise and WhatsApp-friendly (no markdown headings, use bullets and bold where helpful).
```

### Manual feed summary (user asks "summarize my LinkedIn feed")

1. `agent-browser close`
2. `agent-browser --state linkedin-auth.json open https://www.linkedin.com/feed`
3. If URL contains "login", say session expired and stop
4. Scroll 5–8 times (`agent-browser scroll down 600`), snapshot between scrolls (`agent-browser snapshot -i`), and collect post text with `agent-browser get text @eX` for relevant refs
5. Summarize and send the digest to the user

---

## 3. Read LinkedIn messages

When the user asks to check LinkedIn messages or summarize their inbox:

1. `agent-browser close`
2. `agent-browser --state linkedin-auth.json open https://www.linkedin.com/messaging`
3. If redirected to login, say session expired and stop
4. `agent-browser snapshot -i` to see the conversation list and message area
5. Identify conversation list items (refs) and open the most recent or unread conversations
6. For each relevant conversation, get text of the last few messages
7. Summarize for the user: who messaged, what about, any clear action items or follow-ups
8. Keep the summary concise and WhatsApp-friendly

---

## 4. Profile lookup

When the user asks to look up a LinkedIn profile (by name, URL, or search):

1. `agent-browser close`
2. If the user gave a profile URL: `agent-browser --state linkedin-auth.json open <url>`
   - If they gave a name or search term: `agent-browser --state linkedin-auth.json open https://www.linkedin.com/search/results/people/?keywords=<term>`, then use snapshot to open the first relevant profile
3. If redirected to login, say session expired and stop
4. On the profile page: `agent-browser snapshot -i` and extract headline, current role, company, and optionally recent activity or "About"
5. Reply with a short structured summary: name, headline, current role, and any other notable details

---

## 5. Accept all pending invitations

When the user asks to accept all pending LinkedIn connection invitations:

1. `agent-browser close`
2. `agent-browser --state linkedin-auth.json open https://www.linkedin.com/mynetwork/invitation-manager/received/`
3. If redirected to login, say session expired and stop
4. Loop until no pending invitations remain:
   - `agent-browser snapshot -i` to find visible "Accept" buttons (use refs from the snapshot, e.g. buttons labeled "Accept" or similar)
   - If no Accept button is visible, scroll down: `agent-browser scroll down 500` then snapshot again to load more invitations
   - If still no Accept button after scrolling, you are done; report how many you accepted
   - Click one Accept button: `agent-browser click @eX` (use the ref for an Accept button)
   - Wait **500 ms** before the next action: `agent-browser wait 500`
   - Snapshot again and repeat (click next Accept, wait 500 ms, etc.)
5. If the page shows an empty state or "No pending invitations", stop and confirm to the user
6. Tell the user how many invitations were accepted (if you can infer from the loop) or that all visible pending invitations were accepted

**Important:** Use exactly a 0.5 second (500 ms) delay between each accept. Keep scrolling down and accepting until no more Accept buttons appear.

---

## Session expiry (all workflows)

- **Before starting:** Always run `agent-browser close`, then open LinkedIn using `--state linkedin-auth.json`
- **After navigating:** If the current URL contains "login" or the page clearly asks for sign-in, do not retry. Tell the user: "LinkedIn session has expired. Ask me to log in again and I'll re-authenticate and save the new session."
- **After any successful login:** Always run `agent-browser state save linkedin-auth.json` before closing or moving on

## Browser crash recovery

If a command returns an error like "Target page, context or browser has been closed" or the browser becomes unresponsive during any LinkedIn workflow:

1. `agent-browser close` to shut down the crashed daemon
2. Re-open with saved auth in one command: `agent-browser --state linkedin-auth.json open <url>`
4. If redirected to login, report session expiry as above
5. Otherwise, resume the workflow from the current step

Do NOT repeatedly retry failing commands — always close and re-open first.
