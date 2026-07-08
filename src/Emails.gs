// ============================================================
//  EMAILS — renewal reminders
// ============================================================

/**
 * Weekly entry point called by the time-based trigger (every Monday).
 */
function sendWeeklyReminders() {
  sendPerLicenseReminders();
}

/**
 * Sends weekly renewal reminder emails for annual subscriptions whose
 * renewal date (the 1st of renewalMonth) is within 35 days and the
 * subscriber has not yet responded (opted_in or opted_out).
 * Monthly licenses and licenses with no renewalMonth are skipped.
 */
function sendPerLicenseReminders() {
  const now      = new Date();
  const todayMs  = now.getTime();
  const WINDOW   = 60 * 24 * 60 * 60 * 1000; // ~2 months in ms

  const subSheet = getTab(TAB_SUBSCRIPTIONS);
  if (!subSheet) return { ok: false, error: 'Subscriptions tab not found.' };
  const rows     = subSheet.getDataRange().getValues();
  const priceMap = _buildLicensePriceMap();

  const byUser = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[7]) !== 'active') continue;
    const billingCycle    = String(r[9] || 'annual').toLowerCase();
    const renewalMonth    = Number(r[10]) || 0;
    const renewalReminder = r[11] === true || String(r[11] || '').toLowerCase() === 'true';
    const renewalStatus   = String(r[8] || '');
    if (billingCycle !== 'annual' || !renewalReminder || !renewalMonth) continue;
    if (renewalStatus === 'opted_in' || renewalStatus === 'opted_out') continue;

    // Next renewal: 1st of renewalMonth this year; if already past, use next year
    let renewalDate = new Date(now.getFullYear(), renewalMonth - 1, 1);
    if (renewalDate.getTime() <= todayMs) {
      renewalDate = new Date(now.getFullYear() + 1, renewalMonth - 1, 1);
    }
    if (renewalDate.getTime() - todayMs > WINDOW) continue;

    const email = String(r[1]).toLowerCase();
    if (!byUser[email]) byUser[email] = [];
    byUser[email].push({
      id             : String(r[0]),
      licenseName    : String(r[2]),
      licenseId      : String(r[3]),
      suiteKey       : String(r[4]),
      priceAtSignup  : Number(r[13]) || 0,
      renewalDate,
    });
  }

  const MONTHS    = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
  const webAppUrl = getWebAppUrl();
  let emailsSent  = 0;
  const errors    = [];

  for (const email in byUser) {
    const subs = byUser[email];
    try {
      const subsHtml = subs.map(s => {
        const optInUrl      = webAppUrl + '?action=opt_in_renewal&subId='  + s.id;
        const optOutUrl     = webAppUrl + '?action=opt_out_renewal&subId=' + s.id;
        const pi            = priceMap[s.licenseId];
        const currentPrice  = pi ? pi.price : 0;
        const billingCycle  = pi ? pi.billingCycle : 'annual';
        const priceStr      = currentPrice ? ' &bull; ' + _fmtPrice(currentPrice, billingCycle) : '';
        const renewalLabel  = MONTHS[s.renewalDate.getMonth()] + ' 1, ' + s.renewalDate.getFullYear();
        const priceIncrease = s.priceAtSignup && currentPrice && currentPrice > s.priceAtSignup
          ? `<div style="background:#fef7e0;border-left:3px solid #f9ab00;padding:6px 10px;margin:8px 0;font-size:12px;border-radius:2px">
               &#9650; Price increase: was ${_fmtPrice(s.priceAtSignup, billingCycle)}, now ${_fmtPrice(currentPrice, billingCycle)}
             </div>`
          : '';
        return `
<div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin:12px 0">
  <div style="font-weight:500;font-size:15px">${s.licenseName}</div>
  <div style="color:#5f6368;font-size:13px;margin:4px 0 8px">
    SuiteKey: ${s.suiteKey} &bull; Renews ${renewalLabel}${priceStr}
  </div>
  ${priceIncrease}
  <a href="${optInUrl}"
     style="background:#137333;color:#fff;padding:9px 20px;border-radius:4px;
            text-decoration:none;font-size:13px;font-weight:bold;
            display:inline-block;margin-right:8px">&#10003; Yes, Renew</a>
  <a href="${optOutUrl}"
     style="background:#fff;color:#c5221f;padding:9px 20px;border-radius:4px;
            text-decoration:none;font-size:13px;font-weight:bold;
            display:inline-block;border:1px solid #c5221f">&#10007; No, Don't Renew</a>
</div>`;
      }).join('');

      MailApp.sendEmail({
        to      : email,
        subject : 'Action Required: Software License Renewal',
        htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#202124">
  <h2 style="color:#1a73e8">Software License Renewal Reminder</h2>
  <p>Hello,</p>
  <p>The following annual licenses are coming up for renewal.
     Please indicate whether you'd like to continue each subscription:</p>
  ${subsHtml}
  <p style="color:#5f6368;font-size:13px;margin-top:20px">
    You'll receive weekly reminders until you respond for each license.<br>
    Once you reply, no further reminders will be sent for that subscription.<br><br>
    Questions? Contact the License Manager team.
  </p>
</div>`,
      });
      emailsSent++;
    } catch (e) {
      errors.push({ email, error: e.message });
      console.error('sendPerLicenseReminders: failed for ' + email + ' — ' + e.message);
    }
  }
  return { ok: true, emailsSent, errors };
}

function _buildLicensePriceMap() {
  const sheet = getTab(TAB_LICENSES);
  if (!sheet) return {};
  const rows = sheet.getDataRange().getValues();
  const map  = {};
  for (let i = 1; i < rows.length; i++) {
    const id = String(rows[i][0]);
    if (id) map[id] = { price: Number(rows[i][4]) || 0, billingCycle: String(rows[i][9] || 'annual').toLowerCase() };
  }
  return map;
}

function _fmtPrice(price, billingCycle) {
  const formatted = price.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return formatted + '/' + (billingCycle === 'monthly' ? 'mo' : 'yr');
}

/**
 * Admin-callable: registers a weekly time-based trigger (every Monday 8 AM CT).
 * Fires sendWeeklyReminders(), which runs sendPerLicenseReminders() for all
 * annual licenses whose renewal date is within 35 days.
 * Removes any existing renewal trigger first to avoid duplicates.
 */
function setupRenewalTrigger() {
  requireLicenseManager();
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    const fn = t.getHandlerFunction();
    if (fn === 'sendRenewalEmails' || fn === 'sendMonthlyReminders' || fn === 'sendWeeklyReminders') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('sendWeeklyReminders')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .nearMinute(0)
    .inTimezone('America/Chicago')
    .create();
  return { ok: true, message: 'Weekly renewal trigger registered. Fires every Monday at 8 AM CT. FY-aligned licenses (no renewal month set): September reminder only. Licenses with a specific renewal month: weekly reminders starting 2 months before their renewal date.' };
}

/**
 * Sends a sample renewal reminder email to the current admin for testing.
 */
function sendTestRenewalEmail() {
  requireLicenseManager();
  const email     = getCurrentUserEmail();
  const webAppUrl = getWebAppUrl();
  const now       = new Date();
  // Sample renewal date: 1st of next month
  const sampleDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const renewalLabel = MONTHS[sampleDate.getMonth()] + ' 1, ' + sampleDate.getFullYear();

  const sampleSubs = [
    { id: 'TEST-1', licenseName: 'Example Software A', suiteKey: 'SAMPLE-001', price: 1200, billingCycle: 'annual' },
    { id: 'TEST-2', licenseName: 'Example Software B', suiteKey: 'GTIS',        price: 0,    billingCycle: 'annual' },
  ];
  const subsHtml = sampleSubs.map(s => {
    const optInUrl  = webAppUrl + '?action=opt_in_renewal&subId='  + s.id;
    const optOutUrl = webAppUrl + '?action=opt_out_renewal&subId=' + s.id;
    const priceStr  = s.price ? ' &bull; ' + _fmtPrice(s.price, s.billingCycle) : '';
    return `
<div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin:12px 0">
  <div style="font-weight:500;font-size:15px">${s.licenseName}</div>
  <div style="color:#5f6368;font-size:13px;margin:4px 0 12px">
    SuiteKey: ${s.suiteKey} &bull; Renews ${renewalLabel}${priceStr}
  </div>
  <a href="${optInUrl}"
     style="background:#137333;color:#fff;padding:9px 20px;border-radius:4px;
            text-decoration:none;font-size:13px;font-weight:bold;
            display:inline-block;margin-right:8px">&#10003; Yes, Renew</a>
  <a href="${optOutUrl}"
     style="background:#fff;color:#c5221f;padding:9px 20px;border-radius:4px;
            text-decoration:none;font-size:13px;font-weight:bold;
            display:inline-block;border:1px solid #c5221f">&#10007; No, Don't Renew</a>
</div>`;
  }).join('');

  MailApp.sendEmail({
    to      : email,
    subject : '[TEST] Software License Renewal Reminder Preview',
    htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#202124">
  <p style="background:#fff3cd;border-left:4px solid #ffc107;padding:8px 12px;font-size:12px;border-radius:4px">
    <strong>TEST EMAIL</strong> — sent 35 days before a license's renewal date.
  </p>
  <h2 style="color:#1a73e8">Software License Renewal Reminder</h2>
  <p>Hello,</p>
  <p>The following annual licenses are coming up for renewal.
     Please indicate whether you'd like to continue each subscription:</p>
  ${subsHtml}
  <p style="color:#5f6368;font-size:13px;margin-top:20px">
    You'll receive weekly reminders until you respond for each license.<br>
    Once you reply, no further reminders will be sent for that subscription.<br><br>
    Questions? Contact the License Manager team.
  </p>
</div>`,
  });

  return { ok: true, sentTo: email };
}

/**
 * Sends a feedback message from the current user to the admin email.
 */
function sendFeedback(message) {
  message = String(message || '').trim();
  if (!message) throw new Error('Feedback message is required.');
  const senderEmail = getCurrentUserEmail();
  const adminEmail  = (getSettingValue('license_manager_emails') || '').split(',')[0].trim();
  if (!adminEmail) throw new Error('No admin email is configured to receive feedback.');
  const escaped = message.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  MailApp.sendEmail({
    to      : adminEmail,
    replyTo : senderEmail,
    subject : 'License Manager Feedback from ' + senderEmail,
    htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#202124">
  <h3 style="color:#1a73e8">License Manager Feedback</h3>
  <p><strong>From:</strong> <a href="mailto:${senderEmail}" style="color:#1a73e8">${senderEmail}</a></p>
  <div style="background:#f8f9fa;border-left:4px solid #1a73e8;padding:12px 16px;
              border-radius:4px;margin:16px 0;white-space:pre-wrap;font-size:14px;line-height:1.6">${escaped}</div>
  <p style="color:#5f6368;font-size:12px">Reply to this email to respond directly to the sender.</p>
</div>`,
  });
  return { ok: true };
}

/**
 * Returns the deployed web app URL. Used in email links.
 * Falls back to a manually stored URL in ScriptProperties
 * if ScriptApp.getService() is unavailable.
 */
function getWebAppUrl() {
  try {
    const url = ScriptApp.getService().getUrl();
    if (url) return url;
  } catch (e) {}
  return PropertiesService.getScriptProperties().getProperty('WEB_APP_URL') || '';
}

// ============================================================
//  PENDING REQUEST REMINDERS
// ============================================================

/**
 * Sends digest reminder emails to anyone with outstanding pending requests:
 *   - SK verification confirmations (pending_sk_verification) — one email per
 *     suggested approver listing all verification requests awaiting them.
 *   - Subscription approvals (pending) — one email per SK owner listing all
 *     requests waiting for their approval.
 *
 * Intended to run weekly (e.g. every Monday 8 AM). Install via
 * setupPendingReminderTrigger() or add it to the existing weekly trigger.
 */
function sendPendingReminders() {
  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) return { ok: false, error: 'Subscriptions tab not found.' };

  const rows       = sheet.getDataRange().getValues();
  const webAppUrl  = getWebAppUrl();
  const permData   = getPermissionsData();

  // Build SK -> owner map from permissions sheet
  const skOwnerMap = {};
  if (permData.data) {
    for (let i = 1; i < permData.data.length; i++) {
      const sk    = String(permData.data[i][0] || '').trim();
      const owner = String(permData.data[i][2] || '').trim().toLowerCase();
      if (sk && owner) skOwnerMap[sk] = owner;
    }
  }

  // Group pending_sk_verification by approver email, then by SK
  // so each SK gets one row (and one set of Yes/No buttons) in the email.
  const verificationByApprover = {}; // approverEmail -> { sk -> [sub, ...] }
  const approvalByEmail        = {}; // ownerEmail -> [sub, ...]

  for (let i = 1; i < rows.length; i++) {
    const r      = rows[i];
    const status = String(r[7]);
    const sub    = {
      id          : String(r[0]),
      userEmail   : String(r[1]),
      licenseName : String(r[2]),
      suiteKey    : String(r[4]),
      fy          : Number(r[6]),
    };

    if (status === 'pending_sk_verification') {
      const approver = String(r[12] || '').trim().toLowerCase();
      if (!approver) continue;
      if (!verificationByApprover[approver]) verificationByApprover[approver] = {};
      const bySK = verificationByApprover[approver];
      if (!bySK[sub.suiteKey]) bySK[sub.suiteKey] = [];
      bySK[sub.suiteKey].push(sub);

    } else if (status === 'pending') {
      const owner = skOwnerMap[sub.suiteKey];
      if (!owner) continue;
      if (!approvalByEmail[owner]) approvalByEmail[owner] = [];
      approvalByEmail[owner].push(sub);
    }
  }

  let emailsSent = 0;
  const errors   = [];

  // Send SK verification reminders — one row per SK, not per requestor
  for (const approver in verificationByApprover) {
    const bySK = verificationByApprover[approver];
    const skKeys = Object.keys(bySK);
    try {
      const rowsHtml = skKeys.map(sk => {
        const confirmUrl = webAppUrl + '?action=confirm_sk_owner_all&sk=' + encodeURIComponent(sk);
        const denyUrl    = webAppUrl + '?action=deny_sk_owner_all&sk='    + encodeURIComponent(sk);
        return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0"><strong>${sk}</strong></td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;white-space:nowrap">
            <a href="${confirmUrl}" style="background:#137333;color:#fff;padding:6px 14px;border-radius:4px;
               text-decoration:none;font-size:12px;font-weight:bold;display:inline-block;margin-right:6px">Yes, I manage it</a>
            <a href="${denyUrl}" style="background:#c5221f;color:#fff;padding:6px 14px;border-radius:4px;
               text-decoration:none;font-size:12px;font-weight:bold;display:inline-block">No, I don't</a>
          </td>
        </tr>`;
      }).join('');

      MailApp.sendEmail({
        to      : approver,
        subject : 'Reminder: ' + skKeys.length + ' SuiteKey ownership confirmation' + (skKeys.length === 1 ? '' : 's') + ' awaiting your response',
        htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:680px;color:#202124">
  <h3 style="color:#1a73e8">License Manager — Action Required</h3>
  <p>Do you manage the following SuiteKey${skKeys.length === 1 ? '' : 's'}? Please confirm or deny so the associated license request${skKeys.length === 1 ? ' can' : 's can'} proceed.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
    <thead>
      <tr style="background:#f8f9fa">
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e0e0e0">SuiteKey</th>
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e0e0e0">Action</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p style="color:#5f6368;font-size:13px">
    You can also respond from
    <a href="${webAppUrl}" style="color:#1a73e8">License Manager</a>.
  </p>
</div>`,
      });
      emailsSent++;
    } catch (e) {
      errors.push({ email: approver, error: e.message });
      console.error('sendPendingReminders: verification email failed for ' + approver + ' — ' + e.message);
    }
  }

  // Send approval reminder emails
  for (const owner in approvalByEmail) {
    const subs = approvalByEmail[owner];
    try {
      const rowsHtml = subs.map(s => {
        const approveUrl = webAppUrl + '?action=approve&subId=' + s.id;
        const declineUrl = webAppUrl + '?action=decline&subId=' + s.id;
        return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0">${s.suiteKey}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0">${s.licenseName}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0">${s.userEmail}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;white-space:nowrap">
            <a href="${approveUrl}" style="background:#137333;color:#fff;padding:6px 14px;border-radius:4px;
               text-decoration:none;font-size:12px;font-weight:bold;display:inline-block;margin-right:6px">Approve</a>
            <a href="${declineUrl}" style="background:#c5221f;color:#fff;padding:6px 14px;border-radius:4px;
               text-decoration:none;font-size:12px;font-weight:bold;display:inline-block">Decline</a>
          </td>
        </tr>`;
      }).join('');

      MailApp.sendEmail({
        to      : owner,
        subject : 'Reminder: ' + subs.length + ' license request' + (subs.length === 1 ? '' : 's') + ' awaiting your approval',
        htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:680px;color:#202124">
  <h3 style="color:#1a73e8">License Manager — Approval Required</h3>
  <p>The following license request${subs.length === 1 ? ' is' : 's are'} waiting for your approval.
     These have been pending for at least one week.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
    <thead>
      <tr style="background:#f8f9fa">
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e0e0e0">SuiteKey</th>
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e0e0e0">License</th>
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e0e0e0">Requested by</th>
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e0e0e0">Action</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p style="color:#5f6368;font-size:13px">
    You can also approve or decline from
    <a href="${webAppUrl}" style="color:#1a73e8">License Manager - My SuiteKey Charges</a>.
  </p>
</div>`,
      });
      emailsSent++;
    } catch (e) {
      errors.push({ email: owner, error: e.message });
      console.error('sendPendingReminders: approval email failed for ' + owner + ' — ' + e.message);
    }
  }

  return { ok: true, emailsSent, errors };
}

/**
 * Installs a weekly Monday 8 AM CT trigger for sendPendingReminders.
 * Removes any existing trigger for the same function first.
 */
function setupPendingReminderTrigger() {
  requireLicenseManager();
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'sendPendingReminders') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('sendPendingReminders')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .nearMinute(0)
    .inTimezone('America/Chicago')
    .create();
  return { ok: true, message: 'Weekly pending reminder trigger set for every Monday at 8 AM CT.' };
}
