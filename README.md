# Brain Dump

**Get it out of your head. I'll help with the rest.**

Brain Dump is a voice-first personal assistant that sits between your thoughts and the tools you already use. You tap once and talk ("I need shampoo, oh and I can't make yoga tomorrow, and remind me to message Sarah later"). It works out what each thought means, checks what already exists, does the safe things straight away, and asks one short question only when it really needs to.

The product is measured by **mental load removed**, not by tasks, notifications or time spent in the app.

```
CAPTURE → UNDERSTAND → REMEMBER → DECIDE → ACT → VERIFY → LEARN
```

**Installing for real people: see [docs/SETUP.md](docs/SETUP.md)** (Render + iPhone, step by step).

## Quick start

```bash
npm install
npm run build
npm start              # http://localhost:8787
npm test               # 143 tests, including the golden suite, the critical UX tests and the 30-day simulation
npm run simulate       # prints the 30-day simulation report (add -- --transcript to see every exchange)
```

Open the app, tap **Start**, choose a name for your assistant ("Milo it is."), and say what's on your mind.

**Try it on a phone without a server:** `npm run build:phone` produces `dist-phone/brain-dump.html`, a single file where the whole engine runs in the browser and data stays on the device. It's type-only (no voice) and has no integrations.

Desktop (tray icon, global shortcut, floating window): `cd desktop && npm install && BRAIN_DUMP_SERVER=http://localhost:8787 npm start`. Press **Cmd/Ctrl+Shift+Space** anywhere to talk.

### Configuration

| Variable | Purpose |
|---|---|
| `PORT`, `HOST` | Where to listen (default `127.0.0.1:8787`) |
| `DATA_DIR` | Encrypted data directory (default `./data`) |
| `INVITE_CODE` | If set, new accounts need this code (recommended for any public server) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Push notification keys. Generated and kept in `DATA_DIR` if unset |
| `BRAIN_DUMP_KEY` | 32-byte encryption key (hex or base64). If unset, one is generated in `DATA_DIR/.key` with mode 0600 |
| `PUBLIC_URL` | Public base URL (used for OAuth redirects and calendar feed links) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Turn on Google Calendar and Gmail |
| `CORS_ORIGINS` | Comma-separated origins allowed to call the API (for example a separately hosted client) |

## How it behaves

- **Streams of thought.** One sentence can hold several intents. The interpreter splits them and you never pick a category.
- **Context first.** "It", "that", "the appointment", "the one tomorrow" and "her" are resolved against the conversation, then against your calendar, lists and contacts. If there's one obvious target it acts. If there are several, it asks one question ("Which one — Tuesday at 2 or Thursday at 9?").
- **Existing state before new state.** "I need to remember yoga tomorrow" finds the yoga that's already booked. "I got the milk" ticks off the existing item. It never creates duplicates.
- **Risk-based confirmation** (`src/core/policy.ts`). *Authorisation* (what you've allowed) is separate from *confirmation* (whether this particular action needs your OK):
  - Low-risk, or reversible and personal: it just does it. Cancelling your own yoga doesn't ask "are you sure?".
  - Affects other people (invites, sends, shared events): it asks until you've approved that kind of action three times, or said "you don't need to ask me about that".
  - Money, permanent deletion, sensitive messages: it **always** confirms. Trust never removes this safeguard.
- **Reversible by default.** Cancelling is a soft cancel and "clear" means archive. Every action is recorded in the **Action Ledger** and can be undone ("put it back", "undo", or the Undo buttons in History).
- **Never claims what it didn't verify.** Each change is read back from the provider before it is reported. Only verified entries appear in "What did you handle?".
- **Waiting states.** "Rick hasn't replied" is tracked as *waiting for Rick*, not as an overdue task. "Sarah is waiting for my answer" shows up in **What still needs me?**
- **Behaviour → suggestion → consent.** Repeated patterns (Thursday calisthenics, weekly milk) produce a suggestion. They are never automated without an explicit yes, and each step (remember → prepare → automate) needs its own consent. Declined suggestions go quiet for 30 days, and never return after two declines.
- **Silence is valid.** It sends at most one proactive suggestion every two days, and only if the suggestion clears a usefulness bar. That bar rises if you often say no.

## Architecture

```
src/core/        provider-independent intelligence (no I/O)
  interpret.ts   segmentation + intent classification (deterministic, explainable)
  time.ts        DST-safe natural-language time parsing, IANA timezones
  resolve.ts     reference/pronoun/person resolution, disambiguation
  policy.ts      the central decision matrix (spec §32)
  executor.ts    data-only action plans → providers → verification → ledger → undo
  assistant.ts   the conversation orchestrator (sessions, one-question rule, flows)
  behaviour.ts   routine/staple/friction detection and suggestion scoring
  briefing.ts    needs-me, handled, schedule, weekly briefing
  scheduler.ts   idempotent background work (reminders, routines, reply-watching)
  providers.ts   Calendar/Email/Messaging/Meeting/Booking/Purchase/Music/Fitness interfaces
src/server/      HTTP API, passwordless auth, encrypted store, SSE sync, OAuth, ICS feed
src/sim/         30-day simulation with correctness checks and mental-load scoring
web/             PWA client (vanilla JS, no build step): voice, offline queue, settings
desktop/         Electron tray app (global shortcut, floating mini window)
```

The server has no runtime dependencies. It uses only Node's standard library.

## Claude (optional)

When the rule-based interpreter can't place a thought, Claude rewrites it into plain commands, for example "the boiler's making that noise again" → "Remind me to get someone to look at the boiler". Those commands then go through the same context resolution, risk matrix, permissions and verification as everything else, so Claude never acts directly (`src/core/assist.ts`).

- **Server:** add an Anthropic API key under **Settings → Claude** (it's checked, then stored encrypted), or set `ANTHROPIC_API_KEY`. The server uses `claude-opus-5` at low effort, with server-side refusal fallbacks enabled.
- **Phone test build:** uses the viewer's own Claude account through the page's `sample` capability, so there's no key to set up.

## Talk with one tap (iPhone)

**Settings → Talk with one tap** creates a dedicated key and walks through a Siri Shortcut (Dictate Text → POST to `/api/quick?format=text` → Speak Text). Assign it to the Action Button, Back Tap, a Home Screen or Lock Screen widget, or "Hey Siri, Brain Dump". Running it again within 10 minutes continues the same conversation, so a follow-up question can be answered. This needs the server reachable over HTTPS (see Hosting).

## Hosting

`Dockerfile` and `render.yaml` are included. On Render: New → Blueprint → this repo, then set `PUBLIC_URL` to the service address. The attached disk keeps the encrypted data; Render disks need a paid instance. Any Docker host works; mount a volume at `/data`.

## Integrations: what is real and what is prepared

| Capability | Status |
|---|---|
| Brain Dump calendar, reminders, shopping, notes, waiting, memory | Built in |
| Apple / Google / Outlook calendar apps | A private **ICS subscription link** lets them show your Brain Dump calendar (read-only in those apps) |
| Google Calendar | Full read/write through the official API (OAuth 2.0 + PKCE, scoped, revocable). New events go to Google, and changes are verified by reading them back |
| Gmail | Search, "has Rick replied?", archive/undo, trash. Sending only if you separately grant the send scope |
| WhatsApp / SMS / email without a sending integration | Messages are **drafted** and handed off through official deep links (`wa.me`, `mailto:`). It never pretends to have sent anything |
| Zoom / Meet / Teams | Uses your personal meeting link ("my Zoom link is …"). Otherwise it says the link is missing. `MeetingProvider` is ready for an API adapter |
| Bookings, purchases | Engine flows exist (slot choice, verification, calendar entry, mandatory price confirmation) behind `BookingProvider` / `PurchaseProvider`. With no adapter connected, it says so and adds the item to your list |
| Spotify / Strava "usual run setup" | Deep links that open the playlist or recording. No hidden API access |

## Privacy and security

- No passwords, ever. Each device holds a random token, and only its SHA-256 hash is stored. You add a device with a single-use 6-digit code that lasts 10 minutes and is rate-limited.
- User documents and OAuth tokens are encrypted at rest (AES-256-GCM) and written atomically. Tokens are never sent to clients.
- A strict CSP. The client renders text nodes only, never `innerHTML`, so user text can't become markup.
- You can inspect and change everything in Settings: assistant name, permissions per scope, trust, memories (with provenance: told / observed / inferred / suggested / confirmed), routines, connected services, devices, history. You can export all your data or delete your account.
- The microphone is used only after an explicit tap or shortcut, and it follows OS and browser rules.

## Platform limits (honest)

- **Background listening.** Mobile browsers stop the microphone when you switch apps. The conversation stays open on the server (10 minutes idle), and listening resumes automatically when you return to Brain Dump. True background audio and a home-screen widget that records in place need a native wrapper. The web app exposes `/?talk=1` (a PWA shortcut that starts listening straight away) and `/?mini=1` (the compact widget view) as the hooks for one.
- **Speech recognition** uses the browser's engine: best in Chrome, Edge and Safari. Where it isn't available the app works by typing.
- **Language understanding** is deterministic and rule-based on purpose: it is predictable, testable and private. Anything it can't classify is saved as a note rather than lost. An LLM fallback for unusual phrasing is a natural next step behind the same `Thought` interface.

## Tests

- `tests/critical.test.ts`: the four critical UX acceptance tests (spec §72–75).
- `tests/golden.test.ts`: the golden suite (§71), run as one continuous day.
- `tests/actions.test.ts`: ambiguity, the risk matrix, earned trust, purchases, email, timezones, existing state, undo, bookings, offline idempotency, naming, waiting states, knowing when *not* to act.
- `tests/behaviour.test.ts`: routine discovery through automation, staples, reply-watching, the scheduler, the weekly conversation.
- `tests/server.test.ts`, `tests/google.test.ts`: auth, pairing, SSE sync, offline replay, encryption at rest, security headers, ICS, and the Google provider against a fake API.
- `tests/simulation.test.ts`: 30 days of messy use. It must finish with zero failures, false claims, duplicates, lost thoughts and unnecessary confirmations.
- `tests/hardening.test.ts`: fuzzing, hostile input, and regressions found by the simulation.
