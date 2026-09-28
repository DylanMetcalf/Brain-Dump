# The Brain Dump iPhone app

The iPhone app is what makes Brain Dump set itself up. It's the same Brain Dump (same screens,
same account, same brain) with the parts only a real iPhone app is allowed to do:

| | Web app | iPhone app |
|---|---|---|
| Talk, chat, organise | ✓ | ✓ |
| "Hey Siri, brain dump" | Needs a hand-built Shortcut | **Built in**: registered automatically |
| Real alarms and timers (Clock) | Notifications only | **✓** (iOS 26 AlarmKit; older iOS: loud notifications) |
| Reminders app | Via Shortcut | **✓** create, complete, verified |
| Calendar (incl. Google on the phone) | Brain Dump's own, or Google sign-in | **✓** find, add, move, cancel her real events |
| Contacts ("text Mum") | You tell it the number | **✓** looked up on the phone, never uploaded |
| Widget, Lock Screen / Control Centre button, Action Button | ✗ | **✓** |
| Keeps the phone's apps in step in the background | ✗ | ✓ (as often as iOS allows) |
| Notes | Kept in Brain Dump | Kept in Brain Dump, shareable to Notes (Apple has no Notes API) |
| WhatsApp / iMessage sending | One tap | One tap (no app may send these for you) |

Nothing to build in Shortcuts. The actions appear in Siri, Spotlight and the Shortcuts app by
themselves: *Capture Thought, Start Brain Dump, Ask Brain Dump, What's Next?, What Needs Me?,
What Did You Handle?, Add Reminder, Check Calendar, Start Conversation, Brain Dump Status*.

## What it's like for her

1. Open Brain Dump → **Let's set up Brain Dump** → the things her iPhone supports are already ticked.
2. **Set it up** → Brain Dump works down the list: *Voice ✓ · Calendar: needs you → Allow* (Apple's
   pop-up) *→ ✓ I can see 6 events this week · Reminders → Allow → ✓ · Contacts → Allow → ✓ · Siri ✓*.
3. **Setup test**: "Say: *Remind me to buy milk*" → *I hear you ✓ · I understand you ✓ · It's saved ✓ ·
   It's in your Reminders app ✓*.
4. **Brain Dump is ready** → 🎙 **Talk to Brain Dump**.

After that she never sees setup again, unless a permission is switched off, something stops
working, or something new becomes available. Then Home shows one card with one button.

## Getting it onto her phone: no Mac needed

GitHub builds the app on its own Mac, signs it with your Apple account and sends it to
**TestFlight** (Apple's official way to hand out an app before it's in the App Store).
She taps one link and it installs like any app, and updates arrive by themselves.

### One-time setup (you, about 30 minutes, once)

1. **Apple Developer Program**: developer.apple.com/programs → Enroll ($99/year). Approval is
   usually same-day. Note your **Team ID** (developer.apple.com → Account → Membership).
2. **Register the app's ID**: developer.apple.com → Certificates, IDs & Profiles → Identifiers → **+** →
   App IDs → App. Bundle ID (explicit): `com.<your-github-name>.braindump` (all lower case). Under
   Capabilities tick **App Groups**. Save.
3. **Create the app**: appstoreconnect.apple.com → Apps → **+ New App** → iOS, name *Brain Dump*,
   pick the bundle ID from step 2, SKU `braindump`.
4. **API key** (lets GitHub sign and upload for you): App Store Connect → Users and Access →
   Integrations → App Store Connect API → **+** → name *GitHub*, access **Admin** → Generate →
   **Download API Key** (the `.p8` file; you can only download it once). Note the **Key ID** and
   the **Issuer ID** shown above the list.
5. **Give GitHub the keys**: your repository on github.com → Settings → Secrets and variables →
   Actions:
   - *Secrets*: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (open the .p8 file in a text editor
     and paste everything, including the BEGIN/END lines), `APPLE_TEAM_ID`.
   - *Variables*: `BRAIN_DUMP_SERVER` = your Render address (e.g. `https://brain-dump-abcd.onrender.com`).
     Only if your bundle ID differs from step 2's pattern: `IOS_BUNDLE_ID`.
6. **Ship it**: github.com → your repository → Actions → **Ship iPhone app to TestFlight** →
   Run workflow. About 10 minutes later the build shows in App Store Connect → TestFlight.
   (After that it ships itself whenever the app changes on `main`.)
7. **Invite her**: App Store Connect → your app → TestFlight → Internal Testing → **+** group →
   add her Apple ID email (add her under Users and Access first, role *Customer Support* is
   enough). Or create a **public link** under External Testing (Apple reviews the first build,
   usually within a day) and put it on Render as `TESTFLIGHT_URL`.

### What she does

1. In Brain Dump (web), setup offers **Get the iPhone app** → **Install from TestFlight**
   (or she taps the email invite) → *Install*.
2. **Open and sign in**: Brain Dump opens the new app and signs her in by itself. No codes.
3. The app sets itself up: tap **Allow** for Calendar, Reminders, Contacts, alarms and the
   microphone. Siri's Brain Dump actions are already there. "Hey Siri, talk to Brain Dump."

TestFlight builds last 90 days; each new build (automatic on changes) resets that.

### Building it yourself on a Mac instead

`brew install xcodegen && cd ios && xcodegen generate && open BrainDump.xcodeproj`, set
`BD_TEAM_ID`, `BD_BUNDLE_ID` and `BRAIN_DUMP_SERVER` in `Config.xcconfig` (or `Local.xcconfig`),
pick her phone and press Run. With a free Apple ID the app lasts 7 days.

## Signing in

She's signed in automatically when she taps **Open and sign in** in Brain Dump on the web (a
one-time link). Otherwise: "I already use Brain Dump" plus the 6-digit code from Settings →
Add another device, or her backup code. Everything she's already
told Brain Dump is there. Each device keeps its own permissions: allowing Calendar on the iPhone
doesn't touch any other device.

## How it fits together

```
Siri / widget / Control Centre / the app
        ↓  (App Intents: thin entry points)
Brain Dump server: understanding → context → plan → risk & permission → orchestrator
        ↓  plain operations ("cancel event EK-123", "reminder 'Buy milk' at 9")
Device agent in the app: EventKit / AlarmKit / Contacts → read back to verify → report
        ↓
Action ledger (undo, history) and Integration Health
```

The CI workflow `.github/workflows/ios.yml` builds the app (unsigned, simulator) on every change
to `ios/`, so a broken build shows up before you open Xcode.
