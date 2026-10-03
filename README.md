# Task Drop

A Rabbit R1 creation. Hold the push-to-talk button, speak a task, check the text,
click once — it lands as a row in your Google Sheet.

Single file, no build step, no dependencies in the app itself. Nothing is sent
anywhere except your own Apps Script endpoint.

---

## How the voice capture works

Task Drop does no audio work of its own. The R1 WebView injects a native bridge
and the whole thing is two messages out and one callback in:

```js
CreationVoiceHandler.postMessage('start');   // on longPressStart
CreationVoiceHandler.postMessage('stop');    // on longPressEnd

window.onPluginMessage = function (data) {
  if (data.type !== 'sttEnded') return;
  // data.transcript holds the text
};
```

The device records and transcribes on-device. No `getUserMedia`, no
`MediaRecorder`, no Web Speech API, no transcription service, no API key, no
WebSocket. This is the same approach the `notes` creation in
[rabbit-r1-creations-public](https://github.com/andr3w-hilton/rabbit-r1-creations-public)
uses, and it is both faster and more accurate than browser-side alternatives on
this hardware.

---

## Setup

### 1. The Apps Script receiver

1. Open the Google Sheet you want the tasks in → **Extensions → Apps Script**.
2. Replace `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs) from this repo.
3. **Project Settings → Script properties**, add:

   | Property     | Value                                      |
   |--------------|--------------------------------------------|
   | `SHARED_KEY` | a long random string you invent            |
   | `SHEET_NAME` | tab name to append to (optional, `Tasks`)  |

   The key lives in script properties, never in the script body.
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the `/exec` URL.

> After *any* code change you must **Manage deployments → edit → Deploy** again,
> or the live URL keeps serving the old version. This is the single most common
> reason a working script appears broken.

### 2. Check it from a browser first

Before touching the device there is also an automated end-to-end run that drives
the real `index.html` in headless Chrome against a mock Apps Script, covering the
capture flow, the button map, all three transports and the offline queue:

```bash
node test/harness.mjs      # 50 checks, needs Node 22+ and Chrome or Edge
```

It stubs `CreationVoiceHandler`, `PluginMessageHandler` and `creationStorage`, so
it exercises the same code paths the R1 does. It needs no npm packages and talks
to no network. Then, for your actual endpoint:

Serve the repo locally and open `endpoint-test.html`:

```bash
python -m http.server 8080
# http://localhost:8080/endpoint-test.html
```

Paste the URL and key, hit **Run all three**. It exercises POST, GET and the
no-cors fallback in the same order the R1 app does, and tells you which your
deployment accepts. It also sends one request with a deliberately wrong key —
that one **must** fail. Don't go further until it does.

### 3. Install on the R1

Open `install.html` on any screen and scan the QR with your R1.

### 4. Give the R1 your endpoint

Either:

- **Type it.** The app opens on the setup screen the first time. Tap a field, the
  R1 keyboard opens, type the URL and key, tap **SAVE** (or click the side button).
- **Scan it.** Open `setup.html` locally, enter your creation URL, the `/exec` URL
  and the key, and it builds a one-time install QR with the config in the URL
  fragment. Scan that with the R1 instead of the plain install QR. The app reads
  the config, writes it to secure storage, and immediately strips it from the
  address bar via `history.replaceState`.

`setup.html` generates the QR entirely in your browser — the key is never
uploaded anywhere and the page saves nothing.

**On QR scanning:** the SDK exposes no QR-reading API. Its `qr/` directory is a
code *generator* for install cards, and the only camera reference is "standard
mobile web technologies", i.e. `getUserMedia` plus a decoder library — heavy,
permission-fragile, and against the "keep it light" constraint. So Task Drop uses
the scanning the device genuinely has: the install card's own URL carries the
config. Same outcome, no camera.

---

## Buttons

| Input | Idle screen | Review screen |
|---|---|---|
| **Hold PTT** | record; release to transcribe | — |
| **Side click** | retry the queue now | **send** |
| **Scroll up / down** | — | move between SEND / EDIT / DISCARD |
| **Long press** | record (same as hold) | **discard** |
| **Touch & hold screen** (~1s) | open setup | — |
| **Tap a chip** | — | run that action |
| **Tap the text** | — | start editing |

The review screen opens with **SEND** selected, so the common path is: hold,
speak, release, read it, click. One button press to send.

### Why setup is a screen-hold, not a hardware long press

Your spec asked for hardware long press to do three things — record on the main
screen, discard on review, and reopen setup. The first two are kept as asked.
Setup moved to a touch-and-hold of the screen (~1s), because binding it to the
same hardware long press that starts recording would make it impossible to
record without risking the settings screen. `notes` uses this same
`pointerdown` + timer pattern for its destructive action.

### Which transport actually worked

The idle screen's bottom-right corner shows `via POST`, `via GET` or
`via NO-CORS` — the last transport that successfully delivered. The result
screen also shows it for a moment after each send (`delivered via POST`). That's
your answer to "which method worked on the device", read straight off the
hardware.

---

## Reliability

- Every note is written to local storage **before** any network call. A send
  that fails, a dead battery or a closed app loses nothing.
- A note leaves the queue only after the endpoint returns `{"ok":true}` (or the
  no-cors fallback fires while the device reports itself online).
- The queue is retried when the app opens, every 60 seconds while it's open, and
  the moment the `online` event fires.
- The top-right badge counts notes still waiting.
- On a failed send the R1 says "Saved, will retry" and the tick turns amber
  reading **QUEUED**; on success it says "Sent" with a green tick.
- Notes are capped at 1800 characters so the GET fallback stays inside URL limits.

### Transport order, and why

1. **POST**, `body: JSON.stringify({ key, note, source: "R1" })`, **no custom
   headers at all**. Without headers, `fetch` labels the body
   `text/plain;charset=UTF-8`, which keeps it a CORS *simple request* — no
   preflight `OPTIONS`. Apps Script web apps don't answer `OPTIONS`, so adding
   `Content-Type: application/json` is exactly what breaks this. Apps Script
   redirects once to `googleusercontent.com`; `redirect: 'follow'` handles it.
2. **GET** with the same values on the query string.
3. **`mode: 'no-cors'` POST** as a last resort. The response is opaque, so
   success can't be read — it's only treated as sent when `navigator.onLine`
   isn't false, and it's labelled `NO-CORS` on screen so you know the delivery
   was never confirmed.

**Blocked is not the same as rejected**, and the distinction is what makes the
queue trustworthy. Each attempt ends in one of three states:

| State | Meaning | What happens next |
|---|---|---|
| `sent` | the endpoint answered `{"ok":true}` | dequeued |
| `rejected` | the endpoint answered, and refused — wrong key, empty note | **stop**, keep it queued, retry later |
| `blocked` | CORS or network; we never heard back | try the next transport |

Only a `blocked` attempt earns a fallback. Firing a blind `no-cors` POST at a
server that just said "bad key" would mark the note delivered and drop it — the
note would be gone and the row would never exist. So a readable refusal ends the
chain, and the amber **QUEUED** screen shows why (`rejected: HTTP 200`).

---

## Security

- **No URL or key is in this repo.** The code ships with empty config; the
  endpoint is entered on the device. Since Pages hosting is public, anything
  hard-coded would be readable by anyone who found the URL.
- The config is stored with `window.creationStorage.secure` (hardware-backed on
  Android M+), base64-encoded as the SDK requires.
- A `localStorage` fallback is used only when `creationStorage` isn't injected —
  i.e. desktop browser testing. On the R1 the secure store is always used.
- `.gitignore` blocks `config.local.*`, `*.secret` and `secrets.*`.
- The setup screen accepts `https://` only, with the usual loopback carve-out
  (`http://localhost`, `http://127.0.0.1`) so you can point it at a local mock
  endpoint while testing.
- The Apps Script compares the key in constant time and refuses empty notes.

The key is a shared secret in a URL-addressable endpoint, so treat it as "keeps
strangers out of my sheet", not as authentication. Rotate it by changing
`SHARED_KEY` in script properties and re-entering it on the device — no code
change and no redeploy of the creation needed.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Nothing reaches the sheet, tick stays amber | Deployment access isn't **Anyone**, or you edited the script without re-deploying. |
| `endpoint-test.html` POST fails, GET passes | Normal on some deployments — the app handles it and will show `via GET`. |
| Only NO-CORS passes | The app can't confirm delivery. Re-deploy as a web app with access **Anyone**. |
| BAD KEY test **passes** | Your script isn't validating the key. Fix before real use — anyone with the URL can write to your sheet. |
| Setup screen on every launch | Config isn't persisting. Check the URL ends in `/exec`; the app rejects anything else. |
| Hold PTT, nothing happens | `CreationVoiceHandler` is missing — you're in a plain browser, not the R1. Use the keyboard fallbacks below. |
| Transcript is empty | Nothing was heard. The app returns to idle and says so; hold and speak again. |
| R1 says something other than "Sent" | Speech output is only available through the R1's LLM (`PluginMessageHandler` with `wantsR1Response`). The prompt pins the wording, but the LLM can occasionally embellish. |
| QR scan didn't carry the config | Firmware may drop the URL fragment. Open the app, hold the screen, type the URL and key instead. |
| Edits lost on a long note | Notes are truncated at 1800 characters to keep the GET fallback viable. |

### Desktop keyboard fallbacks

| Key | Acts as |
|---|---|
| `Space` (hold) | PTT hold / release |
| `Escape` | side click |
| `↑` / `↓` | scroll wheel |

In a browser there's no voice bridge, so releasing Space opens an empty review
screen you can type into — enough to test the send path end to end.

---

## Files

| Path | What it is |
|---|---|
| `index.html` | the creation — the whole app, one file |
| `install.html` | install QR page; derives its URL from where it's served |
| `setup.html` | local-only config QR builder (your key never leaves the browser) |
| `endpoint-test.html` | browser test harness for the endpoint |
| `test/harness.mjs` | automated end-to-end test (headless Chrome, no npm install) |
| `apps-script/Code.gs` | the Google Apps Script receiver |
| `TESTING.md` | the full test plan |
| `.github/workflows/pages.yml` | GitHub Pages deploy |

---

## R1 constraints respected

240 × 282 WebView, fixed `body` dimensions, `overflow: hidden`. Large
high-contrast type, minimum 8px and only for non-essential hints. No WebGL, no
canvas in the app at all (the tick is CSS), no external scripts in `index.html`
— the QR library is only loaded by the two desktop pages. `pointerdown`/
`pointerup` throughout with no `preventDefault()` in the interaction chain,
which is what keeps the R1 keyboard working and avoids the documented
3-second crash.
