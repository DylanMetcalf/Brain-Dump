# Setting up Brain Dump

About 30 minutes for the person hosting it (once), then about 5 minutes per person who uses it.

**What it costs:** Render Starter instance with a 1 GB disk, roughly $7–8/month. Anthropic API usage is usually pennies a month for two people, because Claude is only asked about things the app can't understand by itself.

---

## Part 1 — You (the host)

### 1. Put the code in your GitHub
The code lives on the branch `claude/brain-dump-assistant-li0snt` of `dylanmetcalf/brain-dump`.
Merge it into `main` (open a pull request on GitHub and merge it), or tell Render to use that branch in step 3.

### 2. Get an Anthropic API key (for the Claude help)
1. Go to **console.anthropic.com** and sign in.
2. **Billing**: add a payment method and a small credit (for example $5). Set a monthly limit if you like.
3. **API Keys → Create Key**, name it "Brain Dump", and copy it (it starts with `sk-ant-`). You only see it once.

### 3. Deploy on Render
1. Go to **render.com** and sign in with GitHub.
2. **New → Blueprint**, then pick the `brain-dump` repository (and the branch, if you didn't merge).
3. Render reads `render.yaml` and asks for two values:
   - **INVITE_CODE**: a phrase only you two know, for example `sage garden`. Anyone who wants an account needs it. Capitals don't matter.
   - **ANTHROPIC_API_KEY**: the key from step 2.
   (`BRAIN_DUMP_KEY`, the encryption key for your data, is generated automatically. Don't change it later, or existing data can't be read.)
4. Click **Apply** and wait for the first deploy (3–5 minutes). It's ready when the log says `Brain Dump is listening`.
5. Your address is shown at the top, like `https://brain-dump-xxxx.onrender.com`. Open it on your phone. That's the app.

> Optional, nicer address: Render → your service → **Settings → Custom Domains** if you own a domain.

### 4. Your own phone
Do Part 2 yourself first, so you know the steps before walking her through them.

---

## Part 2 — Each person (on their iPhone)

### 1. Install
1. Open the address in **Safari** (not Chrome; iPhone installs apps from Safari).
2. Tap **Start**, type the **invite code**, and tap Start again.
3. Choose a name for the assistant (for example "Milo") and say **yes** to letting it manage calendar, reminders and shopping.
4. Tap the **Share** button (the square with an arrow), then **Add to Home Screen**, then **Add**.
5. From now on, open Brain Dump from the **Home Screen icon**, not from Safari.

### 2. Turn on notifications
Open the app from the Home Screen, then **Settings → Notifications on this phone → Turn on → Allow**. A test notification should appear.
(On iPhone this only works once the app is on the Home Screen and opened from there. It needs iOS 16.4 or later.)

### 3. Save a backup code
**Settings → Backup code → Get my backup code → Show my backup code** (or use the **Finish setting up** card). Save it in Notes or a password manager.
There's no password; this code is how you get back in on a new phone or after clearing Safari data.

### 4. Siri, alarms, Reminders, Calendar and Notes
Follow **[CONNECTIONS.md](CONNECTIONS.md)**. It covers each connection in the easiest order, with every pop-up and what to tap.

### 5. Using it
- Tap the orb and talk, or type. Say "that's all" when you're done.
- Try: *"I need milk, oh and I can't make yoga tomorrow, and remind me to message Sarah later."*
- Ask: *"What still needs me?"* and *"What did you handle today?"*
- Changed your mind? Say *"undo"* or *"put it back"*.

> Voice in the app itself uses Safari's speech recognition. If the orb doesn't listen on her phone, the keyboard's microphone key and the Siri Shortcut always work.

---

## Part 3 — Good to know

| Topic | Details |
|---|---|
| **Separate accounts** | You each have your own private Brain Dump. Neither of you can see the other's. |
| **Another device** (iPad, laptop) | Settings → Devices → **Add another device** gives a 6-digit code. On the new device, open the address and choose **I already use Brain Dump**. |
| **Lost phone** | On the new phone choose **I already use Brain Dump** and enter the backup code. Then remove the old phone under Settings → Devices. |
| **Google Calendar / Gmail** | Optional. Needs a Google Cloud OAuth client: set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Render, with redirect `https://<your-address>/api/integrations/google/callback`. Without it, Brain Dump keeps its own calendar, and Settings has a subscription link to show it in the iPhone Calendar app. |
| **Updates** | When new code is merged to the branch Render watches, it redeploys automatically. Your data stays on the disk. |
| **Backups** | Render snapshots disks daily. **Settings → Export everything** gives each person their own copy. |
| **Messages** | WhatsApp and text messages are drafted, then opened in WhatsApp or Messages for you to send. It never sends by itself unless an integration that can send is connected and you allow it. |
| **Privacy** | Everything is encrypted on the server. The microphone is only used when you tap. Claude only sees the individual sentences the app couldn't understand. |

## What it can do on an iPhone, honestly

With the Brain Dump Shortcut connected (see [CONNECTIONS.md](CONNECTIONS.md)):

| You say | What happens |
|---|---|
| "Dinner with Sarah Friday at 7" | Event at 7 PM in Brain Dump **and** in the iPhone Calendar (Google Calendar if that's the default). |
| "Remind me to call the dentist tomorrow at 9" | A real reminder in **Reminders**, with an alert. |
| "Wake me at 6:30" / "Set a timer for 10 minutes" | A real alarm in **Clock** / a real timer. |
| "Make a note that the wifi password is sunflower22" | In Brain Dump and in **Notes**. |
| "I need milk, eggs and bread" | In your **Shopping** list in Reminders. |
| "Send a WhatsApp to my mum saying I'll be late" | Message written; one tap opens WhatsApp with it filled in. |
| "Call Mum" | One tap to call, FaceTime or WhatsApp. |
| "Play some Taylor Swift" | One tap opens Spotify or Apple Music on that search. |
| "Check my email" | Reads Gmail once Google is connected. |

Without the Shortcut, everything still works inside Brain Dump, with alarms and reminders arriving as notifications.
No app can send a WhatsApp or iMessage in the background on iPhone, not even Siri, so those always end with one tap.
