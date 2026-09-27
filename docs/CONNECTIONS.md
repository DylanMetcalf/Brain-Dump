# Connecting everything: the easy order

Do these in order. Steps 1–3 take about 15 minutes in total and cover almost everything.
You (the host) do step 0 once; Nicole does the rest on her iPhone, or you do it with her.

| # | What | Who | Time | What it unlocks |
|---|---|---|---|---|
| 0 | Keys on Render | You | 5 min | Claude (understanding), ChatGPT (natural voice) |
| 1 | Install + notifications | Her | 2 min | The app, reminders arriving with the app closed |
| 2 | Google on the iPhone | Her | 2 min | Google Calendar (and invites) with no developer setup |
| 3 | The Brain Dump Shortcut | You build once, she installs | 10 min once, then 1 tap | "Hey Siri, Brain Dump", real alarms, Reminders, Calendar, Notes |
| 4 | A nicer voice | Either | 1 min | Replies that don't sound robotic |
| 5 | Gmail (optional) | You | 15 min | "Check my email" |

---

## 0. Keys on Render (you, once)

Render → your **brain-dump** service → **Environment** → **Add Environment Variable**:

| Key | Value | Why |
|---|---|---|
| `ANTHROPIC_API_KEY` | from console.anthropic.com → API Keys | Claude understands anything, however it's said. Already done. |
| `OPENAI_API_KEY` | from platform.openai.com → API keys (add a few pounds of credit) | Natural speaking voice, and a backup if Claude is ever down. |
| `SHORTCUT_URL` | the iCloud link from step 3 (add it later) | Turns step 3 into one tap for everyone else. |

Press **Save, rebuild and deploy**.

> Your Claude key can't be used for ChatGPT or the other way round. They're two companies with separate keys. Claude stays the brain; ChatGPT does the voice (and steps in if Claude doesn't answer).

## 1. Install and notifications (her, 2 minutes)

1. Open your Render address in **Safari** → Share → **Add to Home Screen** → Add.
   If an older Brain Dump icon is there, delete it first so the new icon shows.
2. Open it **from the Home Screen icon**. Tap **Get started**.
3. Home → **Finish setting up** → **Turn on reminders** → **Allow** on the pop-up.

## 2. Google Calendar, the easy way (her, 2 minutes)

No Google developer account needed: her iPhone talks to Google, and Brain Dump talks to her iPhone.

1. iPhone **Settings → Apps → Calendar → Calendar Accounts → Add Account → Google**. Sign in, keep **Calendars** on.
2. Same page: **Default Calendar** → choose the Google calendar (usually her email address).

Everything Brain Dump adds through the Shortcut (step 3) now lands in Google Calendar,
shows on her computer, and invites work as normal.

## 3. The Brain Dump Shortcut: Siri, alarms, Reminders, Calendar, Notes

Apple only lets Shortcuts create real alarms and write to Reminders, Calendar and Notes. So one
Shortcut is the bridge. Once it's in place it's invisible:

- **"Hey Siri, Brain Dump"** → she talks → Brain Dump sorts it → alarms go into **Clock**, reminders
  and shopping into **Reminders**, events into **Calendar** (Google), notes into **Notes** → Siri reads the
  answer back in Siri's own voice. If Brain Dump asks something ("What time?"), it listens for the answer.
- Things added **inside the app** go across too: the app runs the Shortcut straight after (or shows an
  **Add to iPhone** button, if she prefers).

### 3a. Build it once (you, about 10 minutes)

In Brain Dump: **Settings → Siri & iPhone apps → Create my link → Copy link**.

In the **Shortcuts** app, tap **+**, name it **Brain Dump**, then add these steps. Wherever it says
`Item › title`: insert **Repeat Item**, tap it, choose **Dictionary**, and type the key (`title`) under
**Get Value for Key**.

1. **Text**: paste your link.
2. **If**: *Shortcut Input* **has any value**
   - inside: **Set Variable** `Said` to *Shortcut Input*
   - under **Otherwise**: **Dictate Text** (▸ Stop Listening: *After Pause*), then **Set Variable** `Said` to *Dictated Text*
3. After **End If**: **Get Contents of URL**: URL = the *Text*; ▸ Method **POST**, Request Body **JSON**, field `text` = `Said`.
4. **Get Dictionary Value**: `phone` in *Contents of URL*.
5. **Repeat with Each** item in *Dictionary Value*. Inside it, one **If** per type (*If* `Item › type` *is* …):
   - `alarm` → **Create Alarm**: time `Item › time`, label `Item › title`
   - `timer` → **Start Timer**: `Item › minutes` minutes
   - `reminder` → **Add New Reminder**: `Item › title`; ▸ Alert **At Time** `Item › start`
   - `todo` → **Add New Reminder**: `Item › title`
   - `event` → **Add New Event**: title `Item › title`, start `Item › start`, end `Item › end` (▸ Notes `Item › notes`)
   - `note` → **Create Note**: `Item › title`
   - `shopping` → **Add New Reminder**: `Item › title`, list **Shopping** (or Groceries)
6. After **End Repeat**: **Get Dictionary Value** `text` in *Contents of URL* → **Speak Text** (▸ Voice: pick a Siri voice).
7. **Get Dictionary Value** `listen` in *Contents of URL* → **If** it **is** `yes` → **Run Shortcut** *Brain Dump*.

Test: **"Hey Siri, Brain Dump"** → *"Set an alarm for 7 tomorrow and remind me to put the bins out at 8"*.
Check Clock and Reminders.

### 3b. Make it one tap for her

1. In the Shortcut: **ⓘ → Setup → Add Question** on the **Text** step ("Paste your Brain Dump link").
2. **Share → Copy iCloud Link**. Put that link on Render as `SHORTCUT_URL` and redeploy.
3. On her phone: **Settings → Siri & iPhone apps → Create my link → Copy link**, then **Add the Brain Dump Shortcut** →
   **Add Shortcut** → paste her link when it asks.

Each person pastes their *own* link, so nobody sees anyone else's things.

### The pop-ups, and what to tap

| Pop-up | Tap |
|---|---|
| "Allow Brain Dump to connect to …onrender.com?" | **Always Allow** |
| "Allow access to Reminders / Calendar / Notes?" | **Allow** / **Always Allow** |
| Dictation / microphone | **Allow** |
| Asked again every time | Shortcuts → hold **Brain Dump** → **Details (ⓘ)** → **Privacy** → set each to **Always Allow** |

### Put it one tap away

- **Siri**: "Hey Siri, Brain Dump"
- **Action Button** (15 Pro and later): Settings → Action Button → Shortcut → Brain Dump
- **Back Tap**: Settings → Accessibility → Touch → Back Tap → Double Tap → Brain Dump
- **Lock Screen / Control Centre** (iOS 18): Control Centre → + → Add a Control → Shortcut → Brain Dump
- **Widget**: hold the Home Screen → Edit → Add Widget → Shortcuts

## 4. A voice that doesn't sound robotic

Pick whichever is easiest:

- **Through Siri** (the Shortcut): replies use the Siri voice you chose in step 6. Already natural.
- **In the app, with ChatGPT**: with `OPENAI_API_KEY` on Render (or a key pasted in **Settings → Voice**),
  replies use a natural voice. **Settings → Voice** → tap a voice to hear it (*Sage* is calm, *Coral* warm).
- **In the app, free**: iPhone **Settings → Accessibility → Spoken Content → Voices → English** → download
  one marked **Enhanced** or **Premium**. Then pick it in Brain Dump → **Settings → Voice**.

**Turning spoken replies off**: the **Replies out loud / Replies on screen** switch at the top of the
Talk page (also in Settings → Voice). She still talks; the answers just stay on screen.

## 5. Gmail (optional, for "check my email")

Reading email needs Google's permission for the app itself, which means a one-time Google Cloud setup:

1. console.cloud.google.com → new project **Brain Dump**.
2. **APIs & Services → Library** → enable **Gmail API** (and **Google Calendar API** if you also want the direct calendar link).
3. **OAuth consent screen** → External → app name Brain Dump, your email → add both your email addresses under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application** →
   Authorised redirect URI: `https://<your-address>.onrender.com/api/integrations/google/callback`.
5. Put the client ID and secret on Render as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` → redeploy.
6. In Brain Dump: **Settings → Connections → Gmail** → sign in → **Continue** past "Google hasn't verified this app" (it's your own).

## What still takes one tap, and why

WhatsApp, Messages, phone calls and music open with the message, number or search ready. She taps
send or play. Apple doesn't let any app send a WhatsApp or iMessage in the background, Siri included.
Deleting something in Brain Dump doesn't delete it from the iPhone apps. Delete it there too.
