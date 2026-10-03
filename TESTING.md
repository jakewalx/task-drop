# Task Drop — test plan

Three passes: the endpoint on its own, the device, then the offline path. Do them
in order; each one assumes the previous passed.

**Pass 0 — the automated run.** Before any of this, `node test/harness.mjs`
drives the real `index.html` in headless Chrome against a mock Apps Script and
asserts 50 behaviours: setup validation, the voice bridge handshake, the review
screen, all three transports, a rejected send staying queued, the offline queue
surviving a restart, draining in order with no duplicates, and the QR config
being stripped from the URL. It needs Node 22+ and Chrome or Edge, and installs
nothing. If that's green, the passes below are about your real endpoint and real
hardware rather than app logic.

Keep the sheet open on a second screen throughout. Every pass writes rows you can
identify by their timestamp.

---

## A. Browser test of the endpoint

Proves the Apps Script deployment works before the R1 is involved at all, so a
device failure later can't be confused with a server failure.

**Setup**

```bash
cd task-drop
python -m http.server 8080
```

Open `http://localhost:8080/endpoint-test.html`. Use `localhost`, not a
`file://` path — a file page has a null origin and browsers treat it differently
from the R1 WebView.

**Steps**

1. Paste the `/exec` URL and your `SHARED_KEY`. Run **Run all three**.
2. Watch the four rows.

**Expected**

| Test | Expected | Meaning |
|---|---|---|
| POST | pass, `HTTP 200 — {"ok":true}` | the preferred path works |
| GET | pass, `HTTP 200 — {"ok":true}` | the fallback works |
| NO-CORS | pass ("request left the browser") | opaque; verify by hand in the sheet |
| BAD KEY | **pass** (meaning *correctly rejected*) | the key is actually checked |

3. Check the sheet: **three new rows**, tagged `[POST …]`, `[GET …]` and
   `[NO-CORS …]`, each with `Source` = `R1`.
4. Confirm **no** row reads `SHOULD NOT APPEAR`. If there is one, the key check
   isn't working — stop and fix `Code.gs` before going further.

**If POST fails but GET passes** — fine. The app detects this and uses GET. Note
which it was; you'll confirm it again on the device.

**If everything fails**

- URL ends in `/exec`, not `/dev`?
- Deployment type **Web app**, execute as **Me**, access **Anyone**?
- Did you re-deploy after your last edit? Manage deployments → edit → Deploy.

**Also test the Apps Script in isolation:** in the Apps Script editor, run the
`selfTest()` function. It writes a row without any network involvement. If that
fails, the problem is the sheet or the key, not CORS.

---

## B. Sending from the R1

**Install**

1. Open `install.html`, scan with the R1.
2. First launch shows **SETUP**.

**Configure — test both routes**

3. *Typed:* tap the URL field, type the `/exec` URL; tap the key field, type the
   key; tap **SAVE**.
   - Expect: idle screen, toast "Saved. Hold the PTT button to add a note."
   - Try an invalid URL first (e.g. `http://foo`) and confirm it refuses with
     "URL must start with https://", and a URL without `/exec` is refused too.
4. *Scanned:* build a config QR in `setup.html`, scan it. The app should land on
   idle with "Endpoint loaded from QR." and no setup screen.
   - Confirm the key is **not** visible in the URL afterwards (it's stripped).

**Capture and send**

5. Hold the PTT button. Expect the pulsing orange ring and **LISTENING**.
6. Speak: "Buy milk on the way home". Release.
7. Expect the **REVIEW** screen with the transcript, **SEND** highlighted orange.
8. Click the side button.
   - Expect: **SENDING** (amber) → green tick, **SENT**, `delivered via POST`
     (or `GET`).
   - Expect the R1 to say **"Sent"**.
   - Expect the queue badge to stay hidden (nothing left waiting).
   - Expect a new row in the sheet within a second or two.
9. **Write down which transport the screen reported.** That's the answer to
   which method works on your hardware — it's also persisted in the bottom-right
   of the idle screen as `via POST` / `via GET` / `via NO-CORS`.

**Button map**

10. Hold, speak, release. On the review screen:
    - Scroll down once → **EDIT** highlights. Scroll again → **DISCARD** (red).
      Scroll down a third time → stays on DISCARD (deliberately clamped, so you
      can't wrap onto a destructive action by accident).
    - Scroll up twice → back to **SEND**.
11. Scroll to **EDIT**, click. Expect the keyboard, cursor at the end of the
    text. Correct a word. Click the side button → it sends the corrected text.
    Verify the sheet shows your correction, not the raw transcript.
12. Hold, speak, release, then **long press**. Expect "Discarded.", back to idle,
    and **no** new row in the sheet. Confirm holding PTT again still starts a
    recording (the discard must not have eaten the next press).
13. Hold PTT and release immediately without speaking. Expect "Nothing heard.
    Hold and speak again." and no review screen.
14. From idle, touch and hold the screen for about a second. Expect **SETUP**,
    pre-filled with your current URL and key. Tap **BACK** to leave without
    changing anything.

---

## C. Offline, then back online

The point of the queue. Nothing may be lost and nothing may be duplicated.

**Go offline**

1. Turn off the R1's Wi-Fi / data.
2. Hold, speak "Offline test one", release, click **SEND**.
   - Expect: amber tick, **QUEUED**, "Saved on device. Will retry."
   - Expect the R1 to say **"Saved, will retry"**.
   - Expect the badge to read **1 QUEUED**.
3. Repeat twice more with "Offline test two" and "Offline test three".
   - Expect the badge to climb to **3 QUEUED**.
4. Check the sheet: **no new rows**.

**Survive a restart while still offline**

5. Close Task Drop. Reopen it.
   - Expect the badge still showing **3 QUEUED** — the queue is on disk, not in
     memory.
6. Click the side button to force a retry while still offline.
   - Expect the badge unchanged and no rows in the sheet.

**Come back online**

7. Turn Wi-Fi back on with the app open.
   - Expect the badge to clear within 60 seconds without you touching anything
     (the `online` event usually fires it immediately).
   - Alternatively click the side button to force it: expect the toast
     "Queue cleared via POST".
8. Check the sheet: **exactly three new rows**, in order, one per offline note.
   - No duplicates — a note leaves the queue only after `{"ok":true}`.
   - No missing notes.

**Partial failure**

9. Go offline, queue two notes. Come back online but first break the endpoint —
   in Apps Script, change `SHARED_KEY` to something else and re-deploy.
10. Click the side button.
    - Expect the badge to stay at **2** and no rows in the sheet (the key is
      rejected, so nothing is dequeued).
11. Restore the correct `SHARED_KEY`, re-deploy, click the side button.
    - Expect both notes to land, badge clears.

This is the important one: a rejected send must never silently drop a note. The
app distinguishes a *blocked* request (CORS/network — fall through to the next
transport) from a *rejected* one (the server answered and refused — stop and keep
it queued), precisely so a wrong key cannot be papered over by the `no-cors`
fallback. `node test/harness.mjs` asserts this case directly.

---

## Pass criteria

- [ ] Endpoint test: POST or GET passes, BAD KEY is rejected, three rows appear
- [ ] `selfTest()` in the Apps Script editor writes a row
- [ ] Setup accepts a valid `/exec` URL and refuses invalid ones
- [ ] Config loads from a scanned QR and the key is stripped from the URL
- [ ] Hold → listening ring; release → transcript on screen
- [ ] Side click sends; green tick; R1 says "Sent"; row in sheet
- [ ] The transport used is reported on screen and noted down
- [ ] Scroll moves SEND → EDIT → DISCARD and clamps at DISCARD
- [ ] EDIT lets you correct the text and the correction is what's sent
- [ ] Long press on review discards and doesn't block the next recording
- [ ] Hold-screen opens setup from idle
- [ ] Offline sends queue, badge counts them, R1 says "Saved, will retry"
- [ ] Queue survives closing and reopening the app
- [ ] Back online, the queue drains on its own within 60s
- [ ] Exactly as many rows as notes — no duplicates, none missing
- [ ] A rejected send keeps the note in the queue
