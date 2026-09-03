# Profanity Muter

A Chrome extension that mutes spoken profanity on YouTube. It transcribes the
audio on your own device with a bundled Whisper model (`base.en`) and mutes the
matching moments as the video plays. Nothing is uploaded: no audio, no
transcripts, no analytics. Once built, it runs fully offline.

This build filters **English** speech only.

## Install from the Chrome Web Store

Install it here:

<!-- STORE_ITEM_ID is the placeholder used across the repo (see
     shared/moments.js). It is filled in with the real item id once the Chrome
     Web Store listing draft is saved (the id is assigned at first draft-save). -->
https://chromewebstore.google.com/detail/STORE_ITEM_ID

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

## License

GPL-3.0. See [LICENSE](LICENSE).
