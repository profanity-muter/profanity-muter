# Chrome Web Store submission - Profanity Muter

Draft to paste into the Developer Console (dev account profile /u/4,
item console 853afb93-d245-4c9e-87a9-11e7756b42ad) once 0.1.44 (bundled
weights) is tested on-device. Publisher: Alex Stone / Urban Algorithm LLC.
Non-trader. Support email: profanity.muter@gmail.com. No website for now.

Guardrails baked in: brand name leads, "for YouTube(TM)" only descriptive,
never "100%/all/guaranteed", trademark disclaimer present, no personal name.

---

## Product name (45 char max)
Profanity Muter for YouTube(TM)

## Summary / short description (132 char max)
Mutes swearing in YouTube videos on your device. Real-time speech filtering, private, no account, works in 27 languages.

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
- The speech models are bundled in the extension. It works with your
  network offline.
- Open source.

YOU ARE IN CONTROL
- Three built-in strictness levels, plus your own added words and phrases.
- Choose what happens before analysis catches up on a new video: play
  normally, mute until ready, or pause until ready.
- Optional password lock for the settings.

27 LANGUAGES
Profanity Muter ships curated word lists for: Arabic, Chinese, Czech,
Danish, Dutch, English, Esperanto, Filipino, Finnish, French (including
Canadian French), German, Hindi, Hungarian, Italian, Japanese, Kabyle,
Korean, Norwegian, Persian, Polish, Portuguese, Russian, Spanish,
Swedish, Thai, and Turkish. It detects the spoken language and switches
lists automatically. (There is a Klingon list in there too, for fun.)

GOOD FOR
Watching with kids, shared and quiet spaces, classrooms, workplaces,
faith communities, and anyone who would simply rather not hear it.

WHAT IT WILL NOT DO
Profanity Muter reduces profanity. It does not eliminate it. Speech
recognition is imperfect, analysis trails the video at the start and
after skipping, and it only knows the words on the list. It filters
regular YouTube(TM) videos, not livestreams, Shorts, or other sites.
YouTube changes can break it until an update ships. Treat it as a good
filter, not a guarantee.

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

## Assets Nate must produce before submitting
- [ ] Screenshots (1280x800 or 640x400), at least 1, up to 5. Suggested:
      (1) the badge showing "Protected" over a YouTube video, (2) the
      popup with strictness levels + added words, (3) the onboarding
      "What it won't do" screen, (4) the settings password lock, (5) the
      language auto-switch notice. Capture on-device after loading 0.1.44.
      No real personal data on screen; use a neutral video.
- [ ] Small promo tile 440x280 (optional but recommended) - can reuse the
      MuteWing mark on the navy field.
- [ ] Store icon: 128x128 already in extension/icons/icon128.png.
- [ ] The packaged .zip: the built extension/ directory INCLUDING the
      bundled models/ dir (produced by 0.1.44). Confirm it loads unpacked
      and transcribes with the network blocked before zipping.

## Pre-submit checklist
- [ ] 0.1.44 tested on Nate's machine, offline transcription confirmed
- [ ] SUPPORT_EMAIL constant = profanity.muter@gmail.com (guard test green)
- [ ] STORE_ITEM_ID constant filled with the real listing id AFTER first
      draft-save (the share/review links need it; a test fails until set)
- [ ] Publisher display name set to "Urban Algorithm" (or "Alex Stone")
- [ ] Non-trader declared
- [ ] Version in manifest matches the zip
