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

## Installing it (you, once)

You need a Mac with **Xcode 26** (free from the Mac App Store) and an Apple ID.

1. Terminal:
   ```sh
   brew install xcodegen
   cd brain-dump/ios
   ```
2. Open `Config.xcconfig` and set:
   - `BRAIN_DUMP_SERVER = https:/$()/your-address.onrender.com` (keep the `$()`)
   - `BD_TEAM_ID =` your Team ID (Xcode → Settings → Accounts → your Apple ID → Team)
3. `xcodegen generate && open BrainDump.xcodeproj`
4. Plug in her iPhone (or use Wi-Fi pairing), pick it at the top of Xcode, press **Run** (▶).
   On the phone: Settings → General → VPN & Device Management → trust your developer profile.

**Free Apple ID:** the app runs for 7 days, then needs re-running from Xcode.
**Apple Developer Program ($99/year):** use **Product → Archive → Distribute → TestFlight**. She
installs **TestFlight** from the App Store, taps your invite, and gets updates automatically.
That's the recommended route.

The App Group (`group.app.braindump`) and bundle id (`app.braindump.BrainDump`) are set in
`project.yml`. If Xcode says the id is taken, change `bundleIdPrefix` and the group name
(`group.<your prefix>`) in `project.yml`, `Shared/Shared.swift` and both entitlements.

## Signing in

She signs in once, inside the app, the same way as on the web ("I already use Brain Dump" plus the
6-digit code from Settings → Add another device, or her backup code). Everything she's already
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
