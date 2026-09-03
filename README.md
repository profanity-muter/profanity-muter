# Profanity Muter

A Chrome extension that mutes spoken profanity on YouTube. It transcribes the
audio on your own device with a bundled Whisper model (`base.en`) and mutes the
matching moments as the video plays. Nothing is uploaded: no audio, no
transcripts, no analytics. Once built, it runs fully offline.

This build filters **English** speech only.

Profanity Muter is an independent, open project. It is not affiliated with,
endorsed by, or sponsored by YouTube or Google LLC. YouTube is a trademark of
Google LLC, referenced here only to describe compatibility.

## How it works

- A speech model runs inside your browser and reads the video's audio slightly
  ahead of the playhead.
- When a word on the active list is coming up, the audio is muted for exactly
  that moment and unmuted right after. The word is removed, not covered over,
  and nothing is added to the audio.
- Open captions and the transcript panel are censored in step with the audio.

Unlike caption-based filters, it reads the actual audio, so it still catches
words when captions lag, are turned off, or are auto-censored.

## Private by design

- Everything runs locally. Your viewing never leaves your device.
- No account, no sign-in, no tracking, no analytics, no ads.
- The speech model is bundled in the extension, so it works with the network
  offline.

## Install from the Chrome Web Store

https://chromewebstore.google.com/detail/oejickocjjdcckcjiabjeakcjkjpabgk

## Build it yourself

Everything runs locally. You need Node.js and Google Chrome.

```sh
git clone https://github.com/profanity-muter/profanity-muter.git
cd profanity-muter/extension
npm install
npm run package
```

`npm run package` fetches the `base.en` Whisper weights into `extension/models/`
and builds `extension/dist/`. It downloads about 280MB the first time, and
`models/` is gitignored, so this step is required before loading the extension
(a bare `npm run build` only warns when `models/` is absent).

Then load the unpacked extension:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` directory.

Open a YouTube video and the extension starts transcribing and muting.

Everything happens on your device. After the build fetches the model once, the
extension needs no network at all: transcription runs against the bundled
weights with remote model loading turned off (`npm run verify:offline` proves
this by loading and transcribing with the network hard-off).

## What it will not do

Profanity Muter reduces profanity by around 90%. It does not eliminate it.

- Analysis trails the video, so the first seconds and the moments right after
  you skip may not be checked yet.
- Speech recognition is imperfect: a misheard word can slip past, and now and
  then a clean word is caught.
- It only knows the words on the active list, plus any you add.
- It filters regular YouTube videos, not Shorts, livestreams, or premieres.

Treat it as a strong filter, not a guarantee.

## Contributing

Issues and pull requests are welcome on GitHub. For anything else, reach the
project at profanity.muter@gmail.com.

## License

GPL-3.0. See [LICENSE](LICENSE).
