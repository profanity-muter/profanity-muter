# Chrome Web Store submission - Profanity Muter

Draft to paste into the Developer Console (dev account profile /u/4,
item console 853afb93-d245-4c9e-87a9-11e7756b42ad) for 0.1.46 (English
only, bundled base.en weights, tested on-device). Publisher: Alex Stone
/ Urban Algorithm LLC. Non-trader. Support email:
profanity.muter@gmail.com. No website for now.

Guardrails baked in: brand name leads, "for YouTube(TM)" only descriptive,
never "100%/all/guaranteed", trademark disclaimer present, no personal name.

---

## Product name (45 char max)
Profanity Muter for YouTube(TM)

## Summary / short description (132 char max)
Mutes swearing in YouTube videos, on your device. Real-time speech filtering. Private, no account, open source.

## Category
Accessibility  (secondary option if needed: Fun / Social & Communication)

## Language (listing default)
English

---

## Detailed description

Profanity Muter listens to the YouTube(TM) video you are watching and
quietly mutes swearing as it plays. Everything happens on your own
computer. No account, no sign-in, nothing is uploaded, and there is no
server involved at any point.

HOW IT WORKS
- A speech model runs inside your browser and reads the audio slightly
  ahead of the playhead.
- When a word on your list is coming up, the audio is muted for exactly
  that moment and unmuted right after. The word is removed, not covered
  over, and nothing is added to the audio.
- Open captions and transcripts are censored in step with the audio.

WHY IT IS DIFFERENT
Most filters read the caption track, so they miss words when captions
lag, are switched off, or are auto-censored to "[ __ ]". Profanity Muter
transcribes the actual audio, so it catches words captions miss and mutes
a tight window around each one instead of a whole sentence.

PRIVATE BY DESIGN
- Everything runs locally. Your viewing never leaves your device.
- No account, no tracking, no analytics, no ads.
- The speech model is bundled in the extension. It works with your
  network offline.
- Open source.

YOU ARE IN CONTROL
- Three built-in strictness levels, plus your own added words and phrases.
- Choose what happens before analysis catches up on a new video: play
  normally, mute until ready, or pause until ready.
- Optional password lock for the settings.

GOOD FOR
Watching with kids, shared and quiet spaces, classrooms, workplaces,
faith communities, and anyone who would simply rather not hear it.

WHAT IT WILL NOT DO
Profanity Muter reduces profanity by around 90%. It does not eliminate
it. Speech recognition is imperfect, analysis trails the video at the
start and after skipping, and it only knows the words on the list. It
filters English speech only, in regular YouTube(TM) videos, not
livestreams, Shorts, premieres, or other sites. YouTube changes can
break it until an update ships. Treat it as a strong filter, not a
guarantee.

---
Profanity Muter is an independent, open project. It is not affiliated
with, endorsed by, sponsored by, or approved by YouTube or Google LLC.
YouTube(TM) is a trademark of Google LLC, referenced only to describe
compatibility.

---

## Single purpose (required field)
Mute and censor profanity in YouTube video audio and captions, on the
user's own device, in real time.

## Permission justifications (required, per permission)

- storage: Save the user's settings (strictness level, added words,
  catch-up behavior, optional settings password, and local statistics).
  All storage is local to the user's browser.

- offscreen: Run the on-device speech-to-text model (WebAssembly) in an
  offscreen document, since a Manifest V3 service worker cannot host the
  long-lived audio processing the model requires.

- alarms: Re-check a 7-day timer used only to decide when to show a
  one-time in-popup review invitation. No network use.

- host permission https://www.youtube.com/*: The extension only operates
  on YouTube video pages. It reads the page's own audio stream to
  transcribe and mute it locally. It requests no other site.

## Data usage disclosures (Privacy tab)
- Does the item collect or use user data? NO data is collected,
  transmitted, or sold. All processing is local to the device.
- Personally identifiable information: No
- Health / financial / authentication / personal communications /
  location / web history / user activity: No to all.
- Remote code: No. All code and speech models are packaged in the
  extension; nothing is fetched at runtime.
- Certify compliance with the Developer Program Policies: Yes.

---

## Assets
- [x] Screenshots (1280x800), 5, in /tmp/pm-shots (1-hero, 2-diff,
      3-privacy, 4-tune, 5-limits). Order: hook, differentiator, privacy,
      control (real popup), limits. Navy/gold system, no personal data.
- [ ] Small promo tile 440x280 (optional but recommended) - can reuse the
      MuteWing mark on the navy field.
- [x] Store icon: 128x128 already in extension/icons/icon128.png.
- [ ] The packaged .zip: the built extension/ directory INCLUDING the
      bundled models/ dir (base.en only, ~280MB, produced by 0.1.46 npm
      run package). Confirm it loads unpacked and transcribes with the
      network blocked before zipping.

## Pre-submit checklist
- [x] 0.1.46 tested on-device, offline transcription + live muting confirmed
- [ ] SUPPORT_EMAIL constant = profanity.muter@gmail.com (guard test green)
- [ ] STORE_ITEM_ID constant filled with the real listing id AFTER first
      draft-save (the share/review links need it; a test fails until set)
- [ ] Publisher display name set to "Urban Algorithm" (or "Alex Stone")
- [ ] Non-trader declared
- [ ] Version in manifest matches the zip
