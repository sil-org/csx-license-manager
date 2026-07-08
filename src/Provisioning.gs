// ============================================================
//  PROVISIONING — archive Gmail "Licensing" threads once a
//  subscription row reaches status = 'active'.
//
//  checkProvisionedSeats() is meant to run on a daily trigger.
//  Call setupProvisioningTrigger() once from Admin > Settings
//  to install it.
// ============================================================

const GMAIL_LABEL = 'Licensing';

/**
 * Scans every inbox thread tagged with the Licensing label.
 * When the email + license in the thread body matches an active
 * row in the Subscriptions sheet, archives the thread.
 */
function checkProvisionedSeats() {
  const label = _getOrCreateLabel(GMAIL_LABEL);
  const threads = label.getThreads();

  if (threads.length === 0) {
    Logger.log('No threads found with label: ' + GMAIL_LABEL);
    return;
  }

  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) { Logger.log('Subscriptions tab not found.'); return; }
  const data = sheet.getDataRange().getValues();

  threads.forEach(thread => {
    if (!thread.isInInbox()) return;

    const body    = thread.getMessages()[0].getPlainBody();
    const email   = _parseProvisioningEmail(body);
    const license = _parseProvisioningLicense(body);

    if (!email) {
      Logger.log('Could not parse email from thread: ' + thread.getId());
      return;
    }

    if (_isProvisioned(data, email, license)) {
      Logger.log('Archiving provisioned seat for: ' + email);
      thread.moveToArchive();
    } else {
      Logger.log('Not yet provisioned: ' + email);
    }
  });
}

/**
 * Installs a daily 8 am trigger for checkProvisionedSeats.
 * Removes any existing trigger for the same function first.
 */
function setupProvisioningTrigger() {
  requireLicenseManager();
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'checkProvisionedSeats') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('checkProvisionedSeats')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();
  return { ok: true, message: 'Daily provisioning trigger set for 8 am.' };
}

// ── private helpers ──────────────────────────────────────────

function _parseProvisioningEmail(body) {
  const match = body.match(/User\s+([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
  return match ? match[1].trim().toLowerCase() : null;
}

function _parseProvisioningLicense(body) {
  const match = body.match(/License\s+([^\n\r]+)/i);
  return match ? match[1].trim() : null;
}

function _isProvisioned(data, email, license) {
  for (let i = 1; i < data.length; i++) {
    const rowEmail   = String(data[i][1] || '').trim().toLowerCase(); // col B
    const rowLicense = String(data[i][2] || '').trim();               // col C
    const rowStatus  = String(data[i][7] || '').trim().toLowerCase(); // col H

    if (rowEmail !== email) continue;
    if (license && rowLicense && !rowLicense.toLowerCase().includes(license.toLowerCase())) continue;
    return rowStatus === 'active';
  }
  return false;
}

function _getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
