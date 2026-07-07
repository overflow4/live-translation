# 🎙️ Live Translate — Spanish ⇄ English

A one-page website that listens to the room through your microphone, transcribes fast-paced **Spanish and English conversation** in real time, and translates all Spanish into English **live**.

Two panels, side by side:

| Left — Conversación (ES + EN) | Right — English only |
| --- | --- |
| Everything exactly as it was said, in whichever language it was said, with language tags and timestamps. | A clean, English-only feed: spoken English appears verbatim; Spanish appears as an instant English translation (with per-line translation latency shown in ms). |

While someone is mid-sentence, the in-flight (interim) transcript streams into the left panel and a live provisional translation streams into the right panel — so the English feed trails the speaker by fractions of a second, not sentences.

## Why it's fast

- **Speech recognition** uses the browser's native Web Speech API (Chrome/Edge), which streams interim results with very low latency — no model download, no backend round-trip of audio.
- **Translation** hits Google's public translate endpoint directly from the browser (typically 100–300 ms per utterance), with MyMemory as an automatic fallback. Interim text is translated on a 220 ms debounce so the English panel updates while people are still talking.
- **Zero backend, zero build step, zero API keys.** Static HTML/CSS/JS.

## Usage

1. Open the site in **Chrome or Edge** (desktop or Android) over HTTPS.
2. Pick the recognition dialect — `Español (EE. UU.)` is the default and handles bilingual Spanish/English ("Spanglish") conversations best. If the conversation is mostly English with some Spanish, try `English (US)`.
3. Hit **▶ Start listening** and allow microphone access. That's it.

The mic session auto-restarts itself whenever the browser ends it (silence, timeouts), so it keeps listening until you press Stop. The screen is kept awake while listening.

> Tip for testing without talking: open DevTools and run `__feed('hola, ¿cómo estás? necesito la factura para mañana')` to push a phrase through the full pipeline.

## Deploy

It's a static site — deploy anywhere. On **Vercel**: *Add New Project → import this repo → Deploy*. No framework preset, no build command, no environment variables.

Run locally with any static server (mic requires localhost or HTTPS):

```bash
npx serve .
# or
python3 -m http.server 8000
```

## Notes & limits

- Requires a browser with the Web Speech API (Chrome, Edge, recent Safari). Firefox is not supported.
- One recognition language is active at a time; the `es-US` model transcribes embedded English well, which is what makes the mixed-conversation mode work.
- Audio is processed by the browser's speech service (Google's, in Chrome); text is sent to the translate endpoint. Nothing is stored anywhere.

## Credits

Forked from [muaz-khan/Translator](https://github.com/muaz-khan/Translator), which pioneered the browser-native speech-recognition + Google-translation combination back in the WebRTC-experiments era. The code here is a full modern rewrite of that idea: new UI, live interim translation, bilingual routing, and current endpoints.

New code is MIT licensed — see [LICENSE](LICENSE).
