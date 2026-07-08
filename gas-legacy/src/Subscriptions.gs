// ============================================================
//  SUBSCRIPTIONS — subscribe, cancel, renewal opt-in
// ============================================================

/**
 * Returns all non-cancelled subscriptions for the current user.
 */
function getMySubscriptions() {
  const email = getCurrentUserEmail();
  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const subs = [];
  for (let i = 1; i < rows.length; i++) {
    const r      = rows[i];
    const status = String(r[7]);
    if (status === 'cancelled') continue;
    if (String(r[1]).toLowerCase() !== email) continue;
    subs.push(_rowToSub(r, i + 1));
  }
  return subs;
}

/**
 * Creates a subscription for recipientEmail (defaults to current user).
 * Any valid SuiteKey may be used. If the requester is not listed as
 * owner/viewer of that SuiteKey in the permissions sheet, the SuiteKey
 * owner receives an email notification.
 *
 * For GTIS-sponsored licenses, suiteKey is ignored entirely.
 */
function createSubscription(licenseId, suiteKey, recipientEmail, suggestedApproverEmail) {
  licenseId = String(licenseId || '').trim();
  if (!licenseId) throw new Error('licenseId is required.');

  const requesterEmail = getCurrentUserEmail();
  if (!requesterEmail) throw new Error('Unable to identify current user.');

  // Validate and normalise recipient email
  recipientEmail = String(recipientEmail || '').trim().toLowerCase();
  if (!recipientEmail) recipientEmail = requesterEmail;
  if (!_isValidEmail(recipientEmail)) throw new Error('Invalid email address: ' + recipientEmail);
  if (!_isAllowedDomain(recipientEmail)) throw new Error('License requests are only available to SIL staff and affiliated organizations. The domain "' + recipientEmail.split('@')[1] + '" is not eligible.');

  // Resolve license details — must happen before suiteKey checks
  // so we know whether this is GTIS-sponsored.
  const licSheet = getTab(TAB_LICENSES);
  const licRows  = licSheet ? licSheet.getDataRange().getValues() : [];
  let licenseName    = '';
  let licenseActive  = false;
  let gtisSponsored  = false;
  let billingCycle   = 'annual';
  let renewalMonth   = 0;
  let renewalReminder = false;
  let activationUrl  = '';
  let licPrice       = 0;
  for (let i = 1; i < licRows.length; i++) {
    if (String(licRows[i][0]) === licenseId) {
      licenseName     = String(licRows[i][1]);
      licPrice        = Number(licRows[i][4]) || 0;
      licenseActive   = licRows[i][7] === true || String(licRows[i][7]).toLowerCase() === 'true';
      gtisSponsored   = licRows[i][8] === true || String(licRows[i][8] || '').toLowerCase() === 'true';
      billingCycle    = String(licRows[i][9] || 'annual').toLowerCase();
      renewalMonth    = Number(licRows[i][10]) || 0;
      renewalReminder = licRows[i][11] === true || String(licRows[i][11] || '').toLowerCase() === 'true';
      activationUrl   = String(licRows[i][14] || '').trim();
      break;
    }
  }
  if (!licenseName) throw new Error('License not found: ' + licenseId);
  if (!licenseActive) throw new Error('This license is no longer available.');

  const currentFY = getCurrentFiscalYear();

  // Billing handling — skipped entirely for GTIS-sponsored licenses
  let effectiveSuiteKey = 'GTIS';
  let skOwnerEmail = '';
  let isSkOwner    = false;
  if (!gtisSponsored) {
    suiteKey = String(suiteKey || '').trim();
    if (!suiteKey) throw new Error('A SuiteKey or Ministry ID is required for this license.');

    // Ministry Account path — no approval needed, user owns their own ministry ID
    if (/^MIN:/i.test(suiteKey)) {
      const ministryId = suiteKey.replace(/^MIN:/i, '').trim();
      if (!/^\d{6}$/.test(ministryId)) throw new Error('Ministry ID must be exactly 6 digits.');
      effectiveSuiteKey = 'MIN:' + ministryId;
      isSkOwner = true; // skip approval
      try { _saveMinistryId(recipientEmail, ministryId); } catch (e) {
        console.error('Ministry ID save failed: ' + e.message);
      }
    } else {

    // Verify the SuiteKey exists in the permissions sheet and check
    // whether the requester is listed (owner or viewer).
    const perm = getPermissionsData();
    let skExists = false;
    if (perm.data) {
      const lower = requesterEmail.toLowerCase();
      for (let i = 1; i < perm.data.length; i++) {
        const row = perm.data[i];
        const sk  = String(row[0] || '').trim();
        if (sk !== suiteKey) continue;
        skExists     = true;
        skOwnerEmail = String(row[2] || '').trim().toLowerCase();
        isSkOwner    = skOwnerEmail === lower;
        break;
      }
    }
    if (!skExists || !skOwnerEmail) {
      // Unknown SuiteKey OR known SK with no manager assigned — require a suggested approver
      suggestedApproverEmail = String(suggestedApproverEmail || '').trim().toLowerCase();
      if (!suggestedApproverEmail) {
        if (!skExists) throw new Error('SuiteKey not found: ' + suiteKey);
        throw new Error('SuiteKey ' + suiteKey + ' has no manager assigned. Please provide the email of the person who manages this SuiteKey budget.');
      }
      if (!_isValidEmail(suggestedApproverEmail)) throw new Error('Invalid approver email: ' + suggestedApproverEmail);

      const newId = generateId('SUB');
      const today = new Date();
      const subSheet2 = getTab(TAB_SUBSCRIPTIONS);
      subSheet2.appendRow([newId, recipientEmail, licenseName, licenseId, suiteKey,
                           today, currentFY, 'pending_sk_verification', '', billingCycle,
                           renewalMonth || '', renewalReminder, suggestedApproverEmail, licPrice]);

      _logAuditEvent('requested', {
        id: newId, userEmail: recipientEmail, licenseName, suiteKey, fy: currentFY,
      }, requesterEmail, 'pending SuiteKey verification — suggested approver: ' + suggestedApproverEmail);

      try {
        _sendSkVerificationEmail(newId, suiteKey, suggestedApproverEmail, requesterEmail, recipientEmail, licenseName);
      } catch (e) {
        console.error('SK verification email failed: ' + e.message);
      }

      return {
        id                  : newId,
        licenseName,
        userEmail           : recipientEmail,
        suiteKey,
        startDate           : today.toISOString().split('T')[0],
        fy                  : currentFY,
        status              : 'pending_sk_verification',
        renewalStatus       : '',
        billingCycle,
        renewalMonth,
        renewalReminder,
        pendingApproverEmail: suggestedApproverEmail,
      };
    }

      effectiveSuiteKey = suiteKey;
    } // end else (SK path)
  }

  // Prevent duplicate active subscription for the same recipient + license + FY
  const subSheet  = getTab(TAB_SUBSCRIPTIONS);
  const subRows   = subSheet ? subSheet.getDataRange().getValues() : [];
  for (let i = 1; i < subRows.length; i++) {
    const r = subRows[i];
    if (String(r[1]).toLowerCase() === recipientEmail &&
        String(r[3]) === licenseId &&
        (String(r[7]) === 'active' || String(r[7]) === 'pending' || String(r[7]) === 'pending_sk_verification') &&
        Number(r[6]) === currentFY) {
      throw new Error(
        (recipientEmail === requesterEmail ? 'You already have' : recipientEmail + ' already has') +
        ' an active subscription to ' + licenseName + ' for FY' + currentFY + '.'
      );
    }
  }

  // Subscriptions require SuiteKey owner approval unless GTIS (no SK) or owner subscribing for self.
  // If the license has an Activation URL, even auto-approved subs wait for admin to provision the seat.
  const needsApproval  = !gtisSponsored && !isSkOwner;
  const needsProvisioning = !!activationUrl;
  const initialStatus  = needsApproval  ? 'pending'
                       : needsProvisioning ? 'approved'
                       : 'active';

  const newId = generateId('SUB');
  const today = new Date();
  subSheet.appendRow([newId, recipientEmail, licenseName, licenseId, effectiveSuiteKey,
                      today, currentFY, initialStatus, '', billingCycle, renewalMonth || '', renewalReminder, '', licPrice]);

  const sub = {
    id             : newId,
    licenseName,
    userEmail      : recipientEmail,
    suiteKey       : effectiveSuiteKey,
    gtisSponsored,
    billingCycle,
    renewalMonth,
    renewalReminder,
    startDate      : today.toISOString().split('T')[0],
    fy             : currentFY,
    status         : initialStatus,
    renewalStatus  : '',
  };

  _logAuditEvent(needsApproval ? 'requested' : 'auto_approved', sub, requesterEmail,
    recipientEmail !== requesterEmail ? 'on behalf of ' + recipientEmail : '');

  if (needsApproval && skOwnerEmail) {
    try {
      _sendApprovalRequestEmail(skOwnerEmail, requesterEmail, recipientEmail, licenseName, effectiveSuiteKey, newId);
    } catch (e) {
      console.error('Approval request email failed: ' + e.message);
    }
  }

  // Auto-approved (GTIS or SK owner) but license requires admin provisioning
  if (!needsApproval && needsProvisioning) {
    try {
      _notifySubscriberApprovedPending(sub);
    } catch (e) {
      console.error('Approved-pending email failed: ' + e.message);
    }
    try {
      _notifyAdminsOfPendingActivation(sub, activationUrl);
    } catch (e) {
      console.error('Admin activation email failed: ' + e.message);
    }
  }

  // Auto-approved and immediately active — add to Google Group if configured
  if (!needsApproval && !needsProvisioning) {
    try {
      _addToGoogleGroup(recipientEmail, _getLicenseGoogleGroup(licenseId));
    } catch (e) {
      console.error('Google Group add failed on auto-approval: ' + e.message);
    }
  }

  return sub;
}

/**
 * Cancels the current user's subscription by setting Status = 'cancelled'.
 */
function cancelSubscription(subscriptionId) {
  const email    = getCurrentUserEmail();
  const subSheet = getTab(TAB_SUBSCRIPTIONS);
  if (!subSheet) throw new Error('Subscriptions tab not found.');
  const rows = subSheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0]) !== subscriptionId) continue;
    if (String(r[1]).toLowerCase() !== email) {
      throw new Error('You can only cancel your own subscriptions.');
    }
    const currentStatus = String(r[7]);
    if (!['active', 'approved', 'pending', 'pending_sk_verification'].includes(currentStatus)) {
      throw new Error('Cannot cancel a subscription with status: ' + currentStatus);
    }
    subSheet.getRange(i + 1, 8).setValue('cancelled');
    const cancelNote = currentStatus === 'active'   ? 'cancelled by subscriber'
                     : currentStatus === 'approved' ? 'withdrawn before activation'
                     : currentStatus === 'pending_sk_verification' ? 'withdrawn before SK verification'
                     : 'withdrawn by requester';
    _logAuditEvent('cancelled', {
      id: subscriptionId, licenseName: String(r[2]),
      userEmail: String(r[1]), suiteKey: String(r[4]), fy: Number(r[6]),
    }, email, cancelNote);
    if (currentStatus === 'active') {
      try {
        const groupEmail = _getLicenseGoogleGroup(String(r[3]));
        if (groupEmail) _removeFromGoogleGroup(String(r[1]), groupEmail);
      } catch (e) {
        console.error('Google Group removal failed on cancel: ' + e.message);
      }
    }
    try {
      _notifyAdminsOfCancellation({
        id: subscriptionId, licenseName: String(r[2]),
        userEmail: String(r[1]), suiteKey: String(r[4]), fy: Number(r[6]),
      }, 'cancelled by subscriber', email, '');
    } catch(e) {}
    return { ok: true };
  }
  throw new Error('Subscription not found: ' + subscriptionId);
}

/**
 * Records a renewal opt-in for the next fiscal year.
 */
function optInRenewal(subscriptionId, fiscalYear) {
  const email    = getCurrentUserEmail();
  const subSheet = getTab(TAB_SUBSCRIPTIONS);
  if (!subSheet) throw new Error('Subscriptions tab not found.');
  const subRows = subSheet.getDataRange().getValues();
  let subRowNum = -1;
  for (let i = 1; i < subRows.length; i++) {
    if (String(subRows[i][0]) !== subscriptionId) continue;
    if (String(subRows[i][1]).toLowerCase() !== email) {
      throw new Error('You can only renew your own subscriptions.');
    }
    subRowNum = i + 1;
    break;
  }
  if (subRowNum < 0) throw new Error('Subscription not found: ' + subscriptionId);

  const fy = Number(fiscalYear) || (getCurrentFiscalYear() + 1);

  const renSheet = getTab(TAB_RENEWALS);
  if (renSheet) {
    const renRows = renSheet.getDataRange().getValues();
    for (let i = 1; i < renRows.length; i++) {
      if (String(renRows[i][1]) === subscriptionId && Number(renRows[i][2]) === fy) {
        return { ok: true, alreadyOptedIn: true };
      }
    }
    renSheet.appendRow([generateId('REN'), subscriptionId, fy, new Date(), email]);
  }

  subSheet.getRange(subRowNum, 9).setValue('opted_in');
  return { ok: true, alreadyOptedIn: false };
}

/**
 * Records a renewal opt-out — user has indicated they will NOT renew.
 * Stops further weekly reminder emails for this subscription.
 */
function optOutRenewal(subscriptionId) {
  const email    = getCurrentUserEmail();
  const subSheet = getTab(TAB_SUBSCRIPTIONS);
  if (!subSheet) throw new Error('Subscriptions tab not found.');
  const rows = subSheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== subscriptionId) continue;
    if (String(rows[i][1]).toLowerCase() !== email) {
      throw new Error('You can only decline renewal for your own subscriptions.');
    }
    if (String(rows[i][7]) !== 'active') {
      throw new Error('Subscription is not active.');
    }
    subSheet.getRange(i + 1, 9).setValue('opted_out');
    return { ok: true };
  }
  throw new Error('Subscription not found: ' + subscriptionId);
}

// ── PRIVATE HELPERS ───────────────────────────────────────────

function _isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function _isAllowedDomain(email) {
  const domain = String(email || '').split('@')[1] || '';
  return ALLOWED_DOMAINS.includes(domain.toLowerCase());
}

/**
 * Saves a Ministry ID for the given email if they don't already have one.
 * Existing IDs are never overwritten here — admin uses updateMinistryId() for corrections.
 */
function _saveMinistryId(email, ministryId) {
  const sp     = PropertiesService.getScriptProperties();
  const permId = sp.getProperty(SPROP_PERMISSIONS_ID);
  if (!permId) return;
  const sheet = SpreadsheetApp.openById(permId).getSheetByName(PERM_TAB_MINISTRY_IDS);
  if (!sheet) return;
  const rows  = sheet.getDataRange().getValues();
  const lower = email.toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim().toLowerCase() === lower) return; // already exists
  }
  sheet.appendRow([lower, ministryId]);
  sp.deleteProperty(SPROP_MINISTRY_IDS_CACHE);
}

/**
 * Emails the SuiteKey owner with Approve / Decline links for a pending request.
 */
function _sendApprovalRequestEmail(ownerEmail, requesterEmail, recipientEmail, licenseName, suiteKey, subId) {
  const webAppUrl  = getWebAppUrl();
  const approveUrl = webAppUrl + '?action=approve&subId=' + subId;
  const declineUrl = webAppUrl + '?action=decline&subId=' + subId;
  const forLine    = recipientEmail !== requesterEmail
    ? `<br>License is for: <strong>${recipientEmail}</strong>` : '';
  MailApp.sendEmail({
    to      : ownerEmail,
    subject : 'Action Required: License request for SuiteKey ' + suiteKey,
    htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#202124">
  <h3 style="color:#1a73e8">License Request — Approval Required</h3>
  <p>A software license has been requested against your SuiteKey and requires your approval before it becomes active.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
    <tr><td style="padding:6px 12px;color:#5f6368;width:140px">SuiteKey</td>
        <td style="padding:6px 12px"><strong>${suiteKey}</strong></td></tr>
    <tr style="background:#f8f9fa">
        <td style="padding:6px 12px;color:#5f6368">License</td>
        <td style="padding:6px 12px">${licenseName}</td></tr>
    <tr><td style="padding:6px 12px;color:#5f6368">Requested by</td>
        <td style="padding:6px 12px">${requesterEmail}${forLine}</td></tr>
  </table>
  <div style="margin:24px 0;display:flex;gap:12px">
    <a href="${approveUrl}" style="background:#137333;color:#fff;padding:12px 28px;border-radius:4px;
       text-decoration:none;font-weight:bold;display:inline-block;margin-right:12px">✓ Approve</a>
    <a href="${declineUrl}" style="background:#c5221f;color:#fff;padding:12px 28px;border-radius:4px;
       text-decoration:none;font-weight:bold;display:inline-block">✗ Decline</a>
  </div>
  <p style="color:#5f6368;font-size:13px">
    You can also approve or decline from
    <a href="${webAppUrl}" style="color:#1a73e8">License Manager → My SuiteKey Charges</a>.
  </p>
</div>`,
  });
}

/**
 * Emails a suggested SuiteKey approver asking them to confirm or deny ownership.
 * CC'd to the first admin email on record.
 */
function _sendSkVerificationEmail(subId, suiteKey, approverEmail, requesterEmail, recipientEmail, licenseName) {
  const webAppUrl  = getWebAppUrl();
  const confirmUrl = webAppUrl + '?action=confirm_sk_owner&subId=' + subId;
  const denyUrl    = webAppUrl + '?action=deny_sk_owner&subId='    + subId;
  const adminEmail = (getSettingValue('license_manager_emails') || '').split(',')[0].trim();
  const forLine    = recipientEmail !== requesterEmail
    ? `<br>License is for: <strong>${recipientEmail}</strong>` : '';
  MailApp.sendEmail({
    to      : approverEmail,
    cc      : adminEmail || undefined,
    subject : 'Action Required: SuiteKey Ownership Confirmation — ' + suiteKey,
    htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#202124">
  <h3 style="color:#1a73e8">SuiteKey Ownership Confirmation</h3>
  <p>You have been identified as the potential owner of SuiteKey <strong>${suiteKey}</strong>
     in <a href="${webAppUrl}" style="color:#1a73e8">License Manager</a>. A license request has been submitted against this SuiteKey
     and requires your confirmation before it can proceed.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
    <tr><td style="padding:6px 12px;color:#5f6368;width:140px">SuiteKey</td>
        <td style="padding:6px 12px"><strong>${suiteKey}</strong></td></tr>
    <tr style="background:#f8f9fa">
        <td style="padding:6px 12px;color:#5f6368">License</td>
        <td style="padding:6px 12px">${licenseName}</td></tr>
    <tr><td style="padding:6px 12px;color:#5f6368">Requested by</td>
        <td style="padding:6px 12px">${requesterEmail}${forLine}</td></tr>
  </table>
  <p>Are you the budget manager for SuiteKey <strong>${suiteKey}</strong>?</p>
  <div style="margin:24px 0">
    <a href="${confirmUrl}" style="background:#137333;color:#fff;padding:12px 28px;border-radius:4px;
       text-decoration:none;font-weight:bold;display:inline-block;margin-right:12px">&#10003; Yes, I manage this SuiteKey</a>
    <a href="${denyUrl}" style="background:#c5221f;color:#fff;padding:12px 28px;border-radius:4px;
       text-decoration:none;font-weight:bold;display:inline-block">&#10007; No, I don't manage it</a>
  </div>
  <p style="color:#5f6368;font-size:13px">
    If you confirm ownership, you will be registered as the SuiteKey owner and immediately
    asked to approve or decline this specific license request.<br>
    If you are not the correct person, click "No" and the requestor will be notified to resubmit
    with the correct approver.
  </p>
</div>`,
  });
}

/**
 * One-time admin function: fills col 13 (priceAtSignup) for any subscription
 * row that currently has no price stored. Uses the current catalog price as
 * the best available approximation for historical sign-up price.
 * Safe to run multiple times — only touches blank/zero cells.
 */
function backfillPriceAtSignup() {
  requireLicenseManager();

  // Build licenseId → price map from catalog
  const licSheet = getTab(TAB_LICENSES);
  if (!licSheet) return { ok: false, error: 'Licenses tab not found.' };
  const licRows  = licSheet.getDataRange().getValues();
  const priceMap = {};
  for (let i = 1; i < licRows.length; i++) {
    const id    = String(licRows[i][0]);
    const price = Number(licRows[i][4]) || 0;
    if (id && price) priceMap[id] = price;
  }

  const subSheet = getTab(TAB_SUBSCRIPTIONS);
  if (!subSheet) return { ok: false, error: 'Subscriptions tab not found.' };
  const rows    = subSheet.getDataRange().getValues();
  let   updated = 0;
  let   skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const existing = Number(rows[i][13]) || 0;
    if (existing) { skipped++; continue; } // already set
    const licenseId = String(rows[i][3]);
    const price     = priceMap[licenseId];
    if (!price) continue; // license not in catalog or price is 0
    subSheet.getRange(i + 1, 14).setValue(price); // col 14 = 1-indexed col 13
    updated++;
  }

  console.log('backfillPriceAtSignup: updated=' + updated + ' skipped=' + skipped);
  return { ok: true, updated, skipped };
}

function _rowToSub(r, rowNum) {
  return {
    id                  : String(r[0]),
    userEmail           : String(r[1]),
    licenseName         : String(r[2]),
    licenseId           : String(r[3]),
    suiteKey            : String(r[4]),
    startDate           : r[5] instanceof Date ? r[5].toISOString().split('T')[0] : String(r[5]),
    fy                  : Number(r[6]),
    status              : String(r[7]),
    renewalStatus       : String(r[8] || ''),
    billingCycle        : String(r[9] || 'annual'),
    renewalMonth        : Number(r[10]) || 0,
    renewalReminder     : r[11] === true || String(r[11] || '').toLowerCase() === 'true',
    pendingApproverEmail: String(r[12] || ''),
    priceAtSignup       : Number(r[13]) || 0,
    rowIndex            : rowNum,
  };
}
