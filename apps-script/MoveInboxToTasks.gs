/**
 * Task Tracker - R1 Inbox -> Tasks auto-mover
 *
 * Separate from the R1 Inbox receiver script. This one lives in the Apps
 * Script project bound to the "Task Tracker" spreadsheet itself (Extensions
 * -> Apps Script, from the sheet), alongside whatever already writes new
 * rows into the "R1 Inbox" tab.
 *
 * What it does, every minute once installed:
 *   - Scans "R1 Inbox" for rows with Status = "New"
 *   - Best-effort splits the free-text note into the Tasks tab's columns
 *   - Appends one row to "Tasks"
 *   - Marks that Inbox row Status = "Moved" (so it never gets copied twice)
 *
 * "R1 Inbox" stays as a permanent log of every voice note ever sent - rows
 * are copied, never deleted. "Tasks" accumulates the structured version.
 *
 * -- The parsing is a heuristic, not a parser -----------------------------
 * A voice transcript has no fixed structure, so this looks for a few common
 * spoken patterns ("the job is X", "the booking is X", a duration, a few
 * priority words) and falls back to "-" for anything it can't find. The full
 * original note is always preserved in Notes/Relevant Info regardless, so a
 * bad guess costs you a quick manual fix, never the information itself.
 *
 * -- Setup (one-time) -------------------------------------------------------
 * 1. Open the Task Tracker spreadsheet -> Extensions -> Apps Script.
 * 2. Add this file (or paste into an existing one) alongside the R1 Inbox
 *    receiver code - same project, doesn't need to be the same file.
 * 3. In the function dropdown at the top, select installR1ToTasksTrigger,
 *    click Run. Approve the permissions prompt the first time.
 * 4. Done. moveNewR1NotesToTasks() now runs automatically every minute.
 *    Re-running installR1ToTasksTrigger() later is safe - it replaces the
 *    old trigger rather than creating a duplicate.
 *
 * To turn it off: Apps Script editor -> Triggers (clock icon, left sidebar)
 * -> delete the moveNewR1NotesToTasks trigger.
 */

var INBOX_SHEET = 'R1 Inbox';
var TASKS_SHEET = 'Tasks';

function installR1ToTasksTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'moveNewR1NotesToTasks') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('moveNewR1NotesToTasks')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('Installed. moveNewR1NotesToTasks() will now run every minute.');
}

function moveNewR1NotesToTasks() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var inbox = ss.getSheetByName(INBOX_SHEET);
  var tasks = ss.getSheetByName(TASKS_SHEET);
  if (!inbox || !tasks) {
    Logger.log('Missing sheet: need both "' + INBOX_SHEET + '" and "' + TASKS_SHEET + '".');
    return;
  }

  var lastRow = inbox.getLastRow();
  if (lastRow < 2) return; // header only, nothing to do

  // Columns: A Received, B Source, C Note, D Status
  var rows = inbox.getRange(2, 1, lastRow - 1, 4).getValues();
  var moved = 0;

  for (var i = 0; i < rows.length; i++) {
    var note = rows[i][2];
    var status = rows[i][3];
    if (!note || status !== 'New') continue;

    var p = parseNote(String(note));

    tasks.appendRow([
      p.task,          // Task
      p.priority,       // Priority
      p.bookingRef,      // Booking Reference
      p.jobRef,            // Job Reference
      p.etc,                // ETC
      note,                  // Notes/Relevant Info - full original transcript
      'R1-' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone() || 'Etc/UTC', 'yyMMddHHmmss'),
      '', '', ''              // Custom 1-3
    ]);

    inbox.getRange(2 + i, 4).setValue('Moved'); // column D
    moved++;
  }

  if (moved) Logger.log('Moved ' + moved + ' note(s) into Tasks.');
}

/**
 * Best-effort split of a free-text voice transcript into the Tasks columns
 * this spreadsheet uses. Returns '-' for anything it can't find - the caller
 * always still has the full note in Notes/Relevant Info regardless.
 */
function parseNote(note) {
  var jobRef = '', bookingRef = '', etc = '', priority = '';

  // "the job is X" / "job reference is X" - requires the linking verb "is",
  // not just the word "job" anywhere, or almost every note would false-match
  // on something like "there's a job with...".
  var jobM = note.match(/\bjob(?:\s+reference)?\s+is\s+([^.,;!?]+)/i);
  if (jobM) jobRef = jobM[1].trim();

  var bookingM = note.match(/\bbooking(?:\s+reference)?\s+is\s+([^.,;!?]+)/i);
  if (bookingM) bookingRef = bookingM[1].trim();

  var etcM = note.match(/\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b/i)
    || note.match(/\b(?:after lunch|this morning|this afternoon|tonight|tomorrow|today|asap)\b/i);
  if (etcM) etc = etcM[0].trim();

  if (/\b(urgent|asap|immediately|priority)\b/i.test(note)) priority = 'URGENT';

  // Task title: first sentence, capped so it doesn't swamp the column.
  var task = note.split(/[.!?]/)[0].trim();
  if (task.length > 70) task = task.slice(0, 67) + '…';
  if (!task) task = note.slice(0, 70);

  return {
    task: task,
    priority: priority || '-',
    bookingRef: bookingRef || '-',
    jobRef: jobRef || '-',
    etc: etc || '-'
  };
}

/**
 * Optional convenience: adds a "Task Drop" menu with a manual "Move now"
 * item, for whenever you don't want to wait for the next minute's trigger.
 * Runs automatically whenever the spreadsheet is opened.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Task Drop')
    .addItem('Move R1 Inbox → Tasks now', 'moveNewR1NotesToTasks')
    .addToUi();
}
