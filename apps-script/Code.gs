/**
 * Task Drop - Google Apps Script receiver
 *
 * Accepts a note from the Rabbit R1 creation and appends one row to a sheet.
 *
 * Handles all three transports the R1 app tries, in its order of preference:
 *   1. POST with a text/plain body  -> e.postData.contents holds the JSON
 *   2. GET with query parameters    -> e.parameter holds key / note / source
 *   3. POST in no-cors mode         -> identical to (1); the browser just
 *                                      cannot read the reply
 *
 * Why text/plain and not application/json: the R1 app sends fetch() with no
 * custom headers so the request stays a CORS "simple request". Adding
 * Content-Type: application/json would trigger a preflight OPTIONS, and Apps
 * Script web apps do not answer OPTIONS. The body is still JSON text; we parse
 * it ourselves.
 *
 * ── Setup ────────────────────────────────────────────────────────────────
 * 1. Open your Google Sheet -> Extensions -> Apps Script.
 * 2. Paste this file over Code.gs.
 * 3. Project Settings -> Script properties -> add:
 *        SHARED_KEY   = a long random string you invent
 *        SHEET_NAME   = the tab name to append to   (optional, default "Tasks")
 *    Keep the key in script properties, never in this file.
 * 4. Deploy -> New deployment -> type "Web app"
 *        Execute as:        Me
 *        Who has access:    Anyone
 *    Copy the /exec URL. That plus SHARED_KEY are what you type into the R1.
 * 5. Re-deploy (Manage deployments -> edit -> Deploy) after any code change,
 *    or the live URL keeps serving the old version.
 */

var DEFAULT_SHEET = 'Tasks';
var HEADERS = ['Timestamp', 'Note', 'Source'];

function doPost(e) {
  try {
    var payload = {};

    // The simple-request body arrives as raw text; parse it ourselves.
    if (e && e.postData && e.postData.contents) {
      try {
        payload = JSON.parse(e.postData.contents) || {};
      } catch (parseErr) {
        payload = {};
      }
    }

    // Fall back to form/query params if anything sent them that way.
    if (!payload.note && e && e.parameter) {
      payload = {
        key:    e.parameter.key,
        note:   e.parameter.note,
        source: e.parameter.source
      };
    }

    return handle(payload);
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    return handle({ key: p.key, note: p.note, source: p.source });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function handle(payload) {
  var props    = PropertiesService.getScriptProperties();
  var expected = props.getProperty('SHARED_KEY');

  if (!expected) {
    return reply({ ok: false, error: 'SHARED_KEY script property is not set' });
  }
  if (!timingSafeEquals(String(payload.key || ''), expected)) {
    return reply({ ok: false, error: 'bad key' });
  }

  var note = String(payload.note || '').trim();
  if (!note) {
    return reply({ ok: false, error: 'empty note' });
  }

  var sheet = getSheet(props.getProperty('SHEET_NAME') || DEFAULT_SHEET);
  sheet.appendRow([new Date(), note, String(payload.source || 'unknown')]);

  return reply({ ok: true });
}

function getSheet(name) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Constant-time-ish compare so a wrong key leaks nothing through timing. */
function timingSafeEquals(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function reply(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this once from the editor to confirm the sheet wiring works without
 * involving the network. Writes a row, then tells you if the key is missing.
 */
function selfTest() {
  var props = PropertiesService.getScriptProperties();
  var key   = props.getProperty('SHARED_KEY');
  if (!key) {
    throw new Error('Set the SHARED_KEY script property first.');
  }
  var out = handle({ key: key, note: 'Self test from the Apps Script editor', source: 'editor' });
  Logger.log(out.getContent());
}
