// ============================================================
// Gmail Attachment Filer — savebpmsd@gmail.com
// Google Apps Script
//
// HOW TO USE:
//   1. Open script.google.com, paste this file, save
//   2. Run setupTriggers() once (it creates all recurring jobs)
//   3. Run backfillAllEmails() once to catch existing emails
//   4. After that, everything runs automatically
//
// TO EDIT THE KEYWORD MAP: find the KEYWORD_MAP section below
// and add, remove, or change keywords and folder names.
// ============================================================

// ============================================================
// CONFIGURATION — edit these values to change behavior
// ============================================================

var CONFIG = {

  // Email address that receives the weekly inbox report
  NOTIFY_EMAIL: 'danyel@bpmsd.com',

  // Gmail label applied to threads after attachments are saved
  // Threads with this label are skipped on future runs
  PROCESSED_LABEL: 'auto-filed',

  // Keyword map — order matters, first match wins
  // keywords: array of strings to look for in the subject line (case-insensitive)
  // folder:   exact name of the Google Drive folder to save attachments into
  KEYWORD_MAP: [
    { keywords: ['cherry', 'cherry hill'],    folder: 'Cherry Hill / Cherry Hill OKL LLC' },
    { keywords: ['chestnut'],                 folder: 'Chestnut' },
    { keywords: ['dove'],                     folder: 'Dove Cove / McDove' },
    { keywords: ['casita', 'cabin'],          folder: 'La Casita' },
    { keywords: ['lincoln'],                  folder: 'Lincoln' },
    { keywords: ['north park', 'mcnorth', 'oaks'], folder: 'North Park / McNorth' },
    { keywords: ['robertson'],                folder: 'Robertson' },
    { keywords: ['san remy'],                 folder: 'San Remy' },
    { keywords: ['flat', 'san antonio'],      folder: 'The Flats on Wakefield' },
    { keywords: ['university', 'unilaco'],    folder: 'University / Unilaco' }
  ]

};

// ============================================================
// CORE FUNCTIONS — do not edit below this line unless you
// know what you are doing
// ============================================================

/**
 * processInbox()
 * Runs every 30 minutes via trigger.
 * Searches inbox for unprocessed emails with attachments.
 * If the subject matches a keyword, saves attachments to Drive
 * and archives the thread. Otherwise leaves it alone.
 */
function processInbox() {
  var query = 'has:attachment in:inbox -label:' + CONFIG.PROCESSED_LABEL;
  processThreadsByQuery(query);
}

/**
 * backfillAllEmails()
 * Run this ONCE manually to catch emails that already exist.
 * Same logic as processInbox() but searches all mail, not just inbox.
 */
function backfillAllEmails() {
  var query = 'has:attachment -label:' + CONFIG.PROCESSED_LABEL;
  processThreadsByQuery(query);
}

/**
 * weeklyInboxReport()
 * Runs every Monday at 8am via trigger.
 * Scans the inbox and if any emails are present, sends a plain-text
 * summary to NOTIFY_EMAIL listing subject, from, and date of each.
 * Does nothing if the inbox is empty.
 */
function weeklyInboxReport() {
  var threads = GmailApp.getInboxThreads();

  if (threads.length === 0) {
    return; // inbox is empty, nothing to report
  }

  var lines = [];
  lines.push('The following emails are sitting in savebpmsd@gmail.com and may need attention:\n');

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var message = thread.getMessages()[0]; // first message in thread
    lines.push('Subject: ' + thread.getFirstMessageSubject());
    lines.push('From:    ' + message.getFrom());
    lines.push('Date:    ' + message.getDate().toDateString());
    lines.push('---');
  }

  var body = lines.join('\n');

  GmailApp.sendEmail(
    CONFIG.NOTIFY_EMAIL,
    'Savebpmsd@ Emails to File',
    body
  );
}

/**
 * setupTriggers()
 * Run this ONCE manually. Deletes all existing triggers for this
 * script, then creates:
 *   - processInbox() every 30 minutes
 *   - weeklyInboxReport() every Monday at 8am
 */
function setupTriggers() {
  // Delete all existing triggers to avoid duplicates
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    ScriptApp.deleteTrigger(existing[i]);
  }

  // processInbox — every 30 minutes
  ScriptApp.newTrigger('processInbox')
    .timeBased()
    .everyMinutes(30)
    .create();

  // weeklyInboxReport — every Monday at 8am
  ScriptApp.newTrigger('weeklyInboxReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();

  Logger.log('Triggers created successfully.');
  Logger.log('  processInbox()      — every 30 minutes');
  Logger.log('  weeklyInboxReport() — every Monday at 8am');
}

// ============================================================
// INTERNAL HELPERS — not meant to be run directly
// ============================================================

/**
 * processThreadsByQuery(query)
 * Shared engine used by processInbox() and backfillAllEmails().
 * Searches Gmail using the given query, then for each thread:
 *   1. Checks subject against keyword map
 *   2. If matched, saves all attachments to the Drive folder
 *   3. Applies the processed label and archives the thread
 */
function processThreadsByQuery(query) {
  var threads = GmailApp.search(query);
  var processedLabel = getOrCreateLabel(CONFIG.PROCESSED_LABEL);

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var subject = thread.getFirstMessageSubject();
    var folderName = matchKeyword(subject);

    if (!folderName) {
      // No keyword match — leave this email alone
      continue;
    }

    var folder = findDriveFolder(folderName);
    if (!folder) {
      Logger.log('WARNING: Drive folder not found: "' + folderName + '" — skipping thread: ' + subject);
      continue;
    }

    // Save all attachments from every message in the thread
    var messages = thread.getMessages();
    for (var j = 0; j < messages.length; j++) {
      var attachments = messages[j].getAttachments();
      for (var k = 0; k < attachments.length; k++) {
        folder.createFile(attachments[k]);
        Logger.log('Saved: ' + attachments[k].getName() + ' → ' + folderName);
      }
    }

    // Label and archive the thread
    thread.addLabel(processedLabel);
    thread.moveToArchive();
    Logger.log('Archived thread: ' + subject);
  }
}

/**
 * matchKeyword(subject)
 * Checks the subject line against CONFIG.KEYWORD_MAP.
 * Returns the folder name for the first keyword that matches,
 * or null if nothing matches.
 */
function matchKeyword(subject) {
  var lowerSubject = subject.toLowerCase();

  for (var i = 0; i < CONFIG.KEYWORD_MAP.length; i++) {
    var entry = CONFIG.KEYWORD_MAP[i];
    var keywords = entry.keywords;

    for (var j = 0; j < keywords.length; j++) {
      if (lowerSubject.indexOf(keywords[j].toLowerCase()) !== -1) {
        return entry.folder;
      }
    }
  }

  return null; // no match
}

/**
 * findDriveFolder(name)
 * Searches Google Drive for a folder with the given name.
 * Returns the first match, or null if none found.
 * savebpmsd@gmail.com must have Editor access to the folder.
 */
function findDriveFolder(name) {
  var results = DriveApp.getFoldersByName(name);
  if (results.hasNext()) {
    return results.next();
  }
  return null;
}

/**
 * getOrCreateLabel(name)
 * Returns the Gmail label with the given name, creating it if
 * it does not already exist.
 */
function getOrCreateLabel(name) {
  var label = GmailApp.getUserLabelByName(name);
  if (!label) {
    label = GmailApp.createLabel(name);
    Logger.log('Created Gmail label: ' + name);
  }
  return label;
}
