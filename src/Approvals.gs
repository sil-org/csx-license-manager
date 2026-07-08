// ============================================================
//  APPROVALS — SuiteKey owner approval flow and audit log
// ============================================================

/**
 * Returns all pending subscriptions charged to any SuiteKey owned
 * by the current user. Shown in the My SuiteKey Charges tab.
 */
function getPendingApprovals() {
  const email = getCurrentUserEmail();
  const owned = getSuiteKeyOwnerKeys(email);
  if (!owned.length) return [];

  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[7]) !== 'pending') continue;
    if (!owned.includes(String(r[4]))) continue;
    result.push({
      id          : String(r[0]),
      userEmail   : String(r[1]),
      licenseName : String(r[2]),
      licenseId   : String(r[3]),
      suiteKey    : String(r[4]),
      startDate   : r[5] instanceof Date ? r[5].toISOString().split('T')[0] : String(r[5]),
      fy          : Number(r[6]),
      status      : 'pending',
    });
  }
  return result;
}

/**
 * SuiteKey owner approves a pending subscription request.
 * If the license has an Activation URL, status goes to 'approved' (pending admin provisioning)
 * and the license manager team receives an email to set up the seat.
 * Otherwise status goes directly to 'active'.
 */
function approveSubscription(subscriptionId) {
  const currentUser = getCurrentUserEmail();
  const owned       = getSuiteKeyOwnerKeys(currentUser);

  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) throw new Error('Subscriptions tab not found.');
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0]) !== subscriptionId) continue;

    const sk = String(r[4]);
    if (!owned.includes(sk)) throw new Error('You do not own SuiteKey: ' + sk);

    const currentStatus = String(r[7]);
    if (currentStatus !== 'pending') {
      throw new Error('Cannot approve a subscription with status: ' + currentStatus);
    }

    const sub = {
      id         : String(r[0]),
      userEmail  : String(r[1]),
      licenseName: String(r[2]),
      licenseId  : String(r[3]),
      suiteKey   : sk,
      fy         : Number(r[6]),
    };

    const activationUrl = _getLicenseActivationUrl(sub.licenseId);
    const newStatus     = activationUrl ? 'approved' : 'active';
    sheet.getRange(i + 1, 8).setValue(newStatus);

    _logAuditEvent('approved', sub, currentUser, '');

    if (activationUrl) {
      try { _notifySubscriberApprovedPending(sub); } catch (e) {
        console.error('Approved-pending email failed: ' + e.message);
      }
      try { _notifyAdminsOfPendingActivation(sub, activationUrl); } catch (e) {
        console.error('Admin activation email failed: ' + e.message);
      }
    } else {
      _notifySubscriberOfDecision(sub, 'approved', currentUser, '');
      _addToGoogleGroup(sub.userEmail, _getLicenseGoogleGroup(sub.licenseId));
    }

    return { ok: true, newStatus, subscriptionId };
  }
  throw new Error('Subscription not found: ' + subscriptionId);
}

/**
 * License Manager admin marks a seat as provisioned, moving the subscription
 * from 'approved' to 'active' and notifying the subscriber.
 */
function activateSubscription(subscriptionId) {
  requireLicenseManager();
  const currentUser = getCurrentUserEmail();

  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) throw new Error('Subscriptions tab not found.');
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0]) !== subscriptionId) continue;

    if (String(r[7]) !== 'approved') {
      throw new Error('Cannot activate a subscription with status: ' + String(r[7]));
    }

    sheet.getRange(i + 1, 8).setValue('active');

    const sub = {
      id         : String(r[0]),
      userEmail  : String(r[1]),
      licenseName: String(r[2]),
      suiteKey   : String(r[4]),
      fy         : Number(r[6]),
    };

    _logAuditEvent('activated', sub, currentUser, 'Seat provisioned by admin');
    try { _notifyUserOfActivation(sub); } catch (e) {
      console.error('Activation email failed: ' + e.message);
    }
    _addToGoogleGroup(sub.userEmail, _getLicenseGoogleGroup(String(r[3])));

    return { ok: true, subscriptionId };
  }
  throw new Error('Subscription not found: ' + subscriptionId);
}

/**
 * SuiteKey owner declines a pending subscription request.
 * @param {string} reason  Optional reason shown to the requestor.
 */
function declineSubscription(subscriptionId, reason) {
  return _changeSubStatus(subscriptionId, 'declined', 'declined', String(reason || '').trim());
}

/**
 * SuiteKey owner revokes a previously approved (active) subscription.
 */
function revokeSubscription(subscriptionId) {
  return _changeSubStatus(subscriptionId, 'revoked', 'revoked');
}

/**
 * Admin cancels any subscription regardless of owner.
 * Works on active, approved, pending, and pending_sk_verification subscriptions.
 * Removes the user from the Google Group if the subscription was active.
 */
function adminCancelSubscription(subscriptionId) {
  requireLicenseManager();
  const adminEmail = getCurrentUserEmail();
  const subSheet   = getTab(TAB_SUBSCRIPTIONS);
  if (!subSheet) throw new Error('Subscriptions tab not found.');
  const rows = subSheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0]) !== subscriptionId) continue;
    const currentStatus = String(r[7]);
    if (['cancelled', 'declined', 'revoked'].includes(currentStatus)) {
      throw new Error('Subscription is already ' + currentStatus + '.');
    }
    subSheet.getRange(i + 1, 8).setValue('cancelled');
    _logAuditEvent('cancelled', {
      id: subscriptionId, licenseName: String(r[2]),
      userEmail: String(r[1]), suiteKey: String(r[4]), fy: Number(r[6]),
    }, adminEmail, 'cancelled by admin');
    if (currentStatus === 'active') {
      try {
        const groupEmail = _getLicenseGoogleGroup(String(r[3]));
        if (groupEmail) _removeFromGoogleGroup(String(r[1]), groupEmail);
      } catch (e) {
        console.error('Google Group removal failed on admin cancel: ' + e.message);
      }
    }
    try {
      _notifyAdminsOfCancellation({
        id: subscriptionId, licenseName: String(r[2]),
        userEmail: String(r[1]), suiteKey: String(r[4]), fy: Number(r[6]),
      }, 'cancelled by admin', adminEmail, '');
    } catch(e) {}
    return { ok: true };
  }
  throw new Error('Subscription not found: ' + subscriptionId);
}

/**
 * Called when a suggested SuiteKey approver clicks "Yes, I own this SuiteKey"
 * in the verification email. Adds the SK to the permissions sheet, clears the
 * permissions cache, moves the subscription to 'pending', and sends the normal
 * approval-request email to the now-confirmed owner.
 */
function confirmSkOwnership(subId) {
  const currentUser = getCurrentUserEmail();
  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) throw new Error('Subscriptions tab not found.');
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0]) !== subId) continue;

    const pendingApprover = String(r[12] || '').trim().toLowerCase();
    if (!pendingApprover || pendingApprover !== currentUser) {
      throw new Error('You are not the designated approver for this request.');
    }
    if (String(r[7]) !== 'pending_sk_verification') {
      throw new Error('This subscription is no longer awaiting SuiteKey verification.');
    }

    const suiteKey    = String(r[4]);
    const licenseName = String(r[2]);
    const userEmail   = String(r[1]);
    const fy          = Number(r[6]);

    // Add or update SK in permissions sheet and clear cache so next read is fresh
    const sp     = PropertiesService.getScriptProperties();
    const permId = sp.getProperty(SPROP_PERMISSIONS_ID);
    if (!permId) throw new Error('Permissions sheet not configured. Contact an admin.');
    try {
      const permSS    = SpreadsheetApp.openById(permId);
      const permSheet = permSS.getSheetByName(PERM_TAB_SUITEKEYS) || permSS.getSheets()[0];
      const permRows  = permSheet.getDataRange().getValues();
      let   skRowNum  = -1;
      for (let j = 1; j < permRows.length; j++) {
        if (String(permRows[j][0] || '').trim() === suiteKey) { skRowNum = j + 1; break; }
      }
      if (skRowNum > 0) {
        permSheet.getRange(skRowNum, 3).setValue(currentUser); // update existing row's owner col
      } else {
        permSheet.appendRow([suiteKey, '', currentUser]);
      }
      sp.deleteProperty(SPROP_PERMISSIONS_CACHE);
    } catch (e) {
      throw new Error('Could not update SuiteKey permissions: ' + e.message);
    }

    // Advance this sub and any other pending_sk_verification subs for the
    // same SK + same approver so none get stranded if multiple were submitted
    // before ownership was confirmed.
    for (let j = 1; j < rows.length; j++) {
      const rj = rows[j];
      if (String(rj[7]) !== 'pending_sk_verification') continue;
      if (String(rj[4]) !== suiteKey) continue;
      if (String(rj[12] || '').trim().toLowerCase() !== currentUser) continue;

      sheet.getRange(j + 1, 8).setValue('pending');
      const sj = { id: String(rj[0]), userEmail: String(rj[1]), licenseName: String(rj[2]), suiteKey, fy: Number(rj[6]) };
      _logAuditEvent('sk_verified', sj, currentUser, currentUser + ' confirmed ownership of ' + suiteKey);
      try {
        _sendApprovalRequestEmail(currentUser, sj.userEmail, sj.userEmail, sj.licenseName, suiteKey, sj.id);
      } catch (e) {
        console.error('Approval request email after SK verification failed: ' + e.message);
      }
    }

    return { ok: true };
  }
  throw new Error('Subscription not found: ' + subId);
}

/**
 * Confirms SK ownership for ALL pending_sk_verification subscriptions
 * on the given SuiteKey where the current user is the designated approver.
 * Registers the SK owner once, then advances every matching sub to pending
 * and sends each requestor an approval-request email.
 * Used by the weekly reminder email (one button per SK, not per sub).
 */
function confirmSkOwnershipAll(suiteKey) {
  suiteKey = String(suiteKey || '').trim();
  if (!suiteKey) throw new Error('SuiteKey is required.');
  const currentUser = getCurrentUserEmail();
  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) throw new Error('Subscriptions tab not found.');
  const rows = sheet.getDataRange().getValues();

  const matching = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[4]) !== suiteKey) continue;
    if (String(r[7]) !== 'pending_sk_verification') continue;
    if (String(r[12] || '').trim().toLowerCase() !== currentUser) continue;
    matching.push({ rowNum: i + 1, r });
  }
  if (!matching.length) throw new Error('No pending verification requests found for SuiteKey ' + suiteKey + ' assigned to you.');

  // Register SK owner in permissions sheet (once)
  const sp     = PropertiesService.getScriptProperties();
  const permId = sp.getProperty(SPROP_PERMISSIONS_ID);
  if (!permId) throw new Error('Permissions sheet not configured. Contact an admin.');
  try {
    const permSheet = SpreadsheetApp.openById(permId).getSheets()[0];
    const permRows  = permSheet.getDataRange().getValues();
    let skRowNum = -1;
    for (let j = 1; j < permRows.length; j++) {
      if (String(permRows[j][0] || '').trim() === suiteKey) { skRowNum = j + 1; break; }
    }
    if (skRowNum > 0) {
      permSheet.getRange(skRowNum, 3).setValue(currentUser);
    } else {
      permSheet.appendRow([suiteKey, '', currentUser]);
    }
    sp.deleteProperty(SPROP_PERMISSIONS_CACHE);
  } catch (e) {
    throw new Error('Could not update SuiteKey permissions: ' + e.message);
  }

  // Advance each matching sub and send approval emails
  for (const { rowNum, r } of matching) {
    sheet.getRange(rowNum, 8).setValue('pending');
    const sub = {
      id         : String(r[0]),
      userEmail  : String(r[1]),
      licenseName: String(r[2]),
      suiteKey,
      fy         : Number(r[6]),
    };
    _logAuditEvent('sk_verified', sub, currentUser,
      currentUser + ' confirmed ownership of ' + suiteKey);
    try {
      _sendApprovalRequestEmail(currentUser, String(r[1]), String(r[1]), String(r[2]), suiteKey, String(r[0]));
    } catch (e) {
      console.error('Approval request email failed after bulk SK verify: ' + e.message);
    }
  }
  return { ok: true, advanced: matching.length };
}

/**
 * Denies SK ownership for ALL pending_sk_verification subscriptions
 * on the given SuiteKey where the current user is the designated approver.
 * Declines each sub and notifies each requestor.
 */
function denySkOwnershipAll(suiteKey) {
  suiteKey = String(suiteKey || '').trim();
  if (!suiteKey) throw new Error('SuiteKey is required.');
  const currentUser = getCurrentUserEmail();
  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) throw new Error('Subscriptions tab not found.');
  const rows = sheet.getDataRange().getValues();

  const matching = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[4]) !== suiteKey) continue;
    if (String(r[7]) !== 'pending_sk_verification') continue;
    if (String(r[12] || '').trim().toLowerCase() !== currentUser) continue;
    matching.push({ rowNum: i + 1, r });
  }
  if (!matching.length) throw new Error('No pending verification requests found for SuiteKey ' + suiteKey + ' assigned to you.');

  for (const { rowNum, r } of matching) {
    sheet.getRange(rowNum, 8).setValue('declined');
    const sub = {
      id: String(r[0]), userEmail: String(r[1]),
      licenseName: String(r[2]), suiteKey, fy: Number(r[6]),
    };
    _logAuditEvent('declined', sub, currentUser,
      'SuiteKey ' + suiteKey + ' ownership denied by suggested approver');
    _notifySubscriberOfDecision(sub, 'declined', currentUser,
      currentUser + ' indicated they do not own SuiteKey ' + suiteKey +
      '. Please resubmit your request with the correct approver email.');
  }
  return { ok: true, declined: matching.length };
}

/**
 * Called when a suggested approver clicks "No, I don't own it".
 * Declines the subscription and notifies the original requester.
 */
function denySkOwnership(subId) {
  const currentUser = getCurrentUserEmail();
  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) throw new Error('Subscriptions tab not found.');
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0]) !== subId) continue;

    const pendingApprover = String(r[12] || '').trim().toLowerCase();
    if (!pendingApprover || pendingApprover !== currentUser) {
      throw new Error('You are not the designated approver for this request.');
    }
    if (String(r[7]) !== 'pending_sk_verification') {
      throw new Error('This subscription is no longer awaiting SuiteKey verification.');
    }

    sheet.getRange(i + 1, 8).setValue('declined');

    const sub = {
      id          : subId,
      userEmail   : String(r[1]),
      licenseName : String(r[2]),
      suiteKey    : String(r[4]),
      fy          : Number(r[6]),
    };
    _logAuditEvent('declined', sub, currentUser,
      'SuiteKey ' + sub.suiteKey + ' ownership denied by suggested approver');
    _notifySubscriberOfDecision(sub, 'declined', currentUser,
      currentUser + ' indicated they do not own SuiteKey ' + sub.suiteKey +
      '. Please resubmit your request with the correct approver email.');

    return { ok: true };
  }
  throw new Error('Subscription not found: ' + subId);
}

function _changeSubStatus(subscriptionId, newStatus, auditAction, reason) {
  const currentUser = getCurrentUserEmail();
  const owned       = getSuiteKeyOwnerKeys(currentUser);

  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) throw new Error('Subscriptions tab not found.');
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0]) !== subscriptionId) continue;

    const sk = String(r[4]);
    if (!owned.includes(sk)) throw new Error('You do not own SuiteKey: ' + sk);

    const currentStatus = String(r[7]);
    const validFrom = {
      approved : ['pending'],
      declined : ['pending'],
      revoked  : ['active', 'approved'],
    };
    if (!(validFrom[auditAction] || []).includes(currentStatus)) {
      throw new Error('Cannot ' + auditAction + ' a subscription with status: ' + currentStatus);
    }

    sheet.getRange(i + 1, 8).setValue(newStatus);

    const sub = {
      id          : String(r[0]),
      userEmail   : String(r[1]),
      licenseName : String(r[2]),
      suiteKey    : sk,
      fy          : Number(r[6]),
    };

    _logAuditEvent(auditAction, sub, currentUser, reason || '');
    _notifySubscriberOfDecision(sub, auditAction, currentUser, reason || '');

    if (auditAction === 'revoked' && currentStatus === 'active') {
      _removeFromGoogleGroup(sub.userEmail, _getLicenseGoogleGroup(String(r[3])));
    }

    if (auditAction === 'revoked') {
      try { _notifyAdminsOfCancellation(sub, 'revoked', currentUser, reason); } catch(e) {}
    }

    return { ok: true, newStatus, subscriptionId };
  }
  throw new Error('Subscription not found: ' + subscriptionId);
}

/**
 * Returns subscriptions for all licenses managed by the current service manager,
 * plus the set of managed license IDs for UI reference.
 */
function getServiceManagerQueue() {
  const email = getCurrentUserEmail();
  const licSheet = getTab(TAB_LICENSES);
  if (!licSheet) throw new Error('Licenses tab not found.');
  const licRows   = licSheet.getDataRange().getValues();
  const lower     = email.toLowerCase();
  const managedIds   = new Set();
  const managedNames = new Set();
  for (let i = 1; i < licRows.length; i++) {
    const active = licRows[i][7] === true || String(licRows[i][7]).toLowerCase() === 'true';
    if (!active) continue;
    if (String(licRows[i][19] || '').trim().toLowerCase() === lower) {
      managedIds.add(String(licRows[i][0]));
      managedNames.add(String(licRows[i][1]).trim().toLowerCase());
    }
  }
  if (!managedIds.size) throw new Error('Access denied: not a service manager.');

  const subSheet = getTab(TAB_SUBSCRIPTIONS);
  if (!subSheet) return { subs: [], licenseIds: [...managedIds] };
  const rows = subSheet.getDataRange().getValues();
  const subs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[7]) === 'cancelled') continue;
    if (!managedIds.has(String(r[3]))) continue;
    subs.push({
      id          : String(r[0]),
      userEmail   : String(r[1]),
      licenseName : String(r[2]),
      licenseId   : String(r[3]),
      suiteKey    : String(r[4]),
      startDate   : r[5] instanceof Date ? r[5].toISOString().split('T')[0] : String(r[5]),
      fy          : Number(r[6]),
      status      : String(r[7]),
    });
  }
  return { subs, licenseIds: [...managedIds] };
}

/**
 * Returns audit log entries filtered to licenses managed by the current service manager.
 */
function getServiceManagerAuditLog() {
  const email = getCurrentUserEmail();
  const licSheet = getTab(TAB_LICENSES);
  if (!licSheet) return [];
  const licRows   = licSheet.getDataRange().getValues();
  const lower     = email.toLowerCase();
  const managedNames = new Set();
  for (let i = 1; i < licRows.length; i++) {
    const active = licRows[i][7] === true || String(licRows[i][7]).toLowerCase() === 'true';
    if (!active) continue;
    if (String(licRows[i][19] || '').trim().toLowerCase() === lower) {
      managedNames.add(String(licRows[i][1]).trim().toLowerCase());
    }
  }
  if (!managedNames.size) return [];

  const sheet = getTab(TAB_AUDIT);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const log  = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!String(r[0])) continue;
    if (!managedNames.has(String(r[4]).trim().toLowerCase())) continue;
    log.push({
      id          : String(r[0]),
      timestamp   : r[1] instanceof Date ? r[1].toISOString() : String(r[1]),
      action      : String(r[2]),
      subId       : String(r[3]),
      licenseName : String(r[4]),
      userEmail   : String(r[5]),
      suiteKey    : String(r[6]),
      performedBy : String(r[7]),
      notes       : String(r[8] || ''),
    });
  }
  return log.reverse();
}

/**
 * Service manager marks an approved subscription as active (provisioned).
 * Also accepts calls from full admins.
 */
function markProvisioned(subscriptionId, price) {
  const currentUser = getCurrentUserEmail();
  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) throw new Error('Subscriptions tab not found.');
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0]) !== subscriptionId) continue;
    if (String(r[7]) !== 'approved') {
      throw new Error('Cannot provision a subscription with status: ' + String(r[7]));
    }

    const licenseId = String(r[3]);
    const licSheet  = getTab(TAB_LICENSES);
    if (!licSheet) throw new Error('Licenses tab not found.');
    const licRows = licSheet.getDataRange().getValues();
    let isMgr = isLicenseManager(currentUser);
    if (!isMgr) {
      for (let j = 1; j < licRows.length; j++) {
        if (String(licRows[j][0]) === licenseId) {
          if (String(licRows[j][19] || '').trim().toLowerCase() === currentUser.toLowerCase()) isMgr = true;
          break;
        }
      }
    }
    if (!isMgr) throw new Error('Access denied: not the service manager for this license.');

    sheet.getRange(i + 1, 8).setValue('active');
    const purchasePrice = parseFloat(price) || 0;
    if (purchasePrice > 0) sheet.getRange(i + 1, 14).setValue(purchasePrice);
    const sub = {
      id          : String(r[0]),
      userEmail   : String(r[1]),
      licenseName : String(r[2]),
      suiteKey    : String(r[4]),
      fy          : Number(r[6]),
    };
    _logAuditEvent('activated', sub, currentUser, 'Seat provisioned by service manager');
    try { _notifyUserOfActivation(sub); } catch (e) { console.error('Activation email failed: ' + e.message); }
    _addToGoogleGroup(sub.userEmail, _getLicenseGoogleGroup(licenseId));
    return { ok: true, subscriptionId };
  }
  throw new Error('Subscription not found: ' + subscriptionId);
}

/**
 * Returns audit log entries.
 * - Admins: all entries (optionally filtered by suiteKey)
 * - SuiteKey owners: only entries for their SuiteKeys
 * Results are returned newest-first.
 */
function getAuditLog(suiteKeyFilter) {
  const email   = getCurrentUserEmail();
  const isAdmin = isLicenseManager(email);
  const owned   = getSuiteKeyOwnerKeys(email);

  if (!isAdmin && !owned.length) throw new Error('Access denied.');

  const sheet = getTab(TAB_AUDIT);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const log  = [];
  for (let i = 1; i < rows.length; i++) {
    const r  = rows[i];
    const sk = String(r[6]);
    if (!isAdmin && !owned.includes(sk)) continue;
    if (suiteKeyFilter && sk !== suiteKeyFilter) continue;
    if (!String(r[0])) continue;
    log.push({
      id          : String(r[0]),
      timestamp   : r[1] instanceof Date ? r[1].toISOString() : String(r[1]),
      action      : String(r[2]),
      subId       : String(r[3]),
      licenseName : String(r[4]),
      userEmail   : String(r[5]),
      suiteKey    : sk,
      performedBy : String(r[7]),
      notes       : String(r[8] || ''),
    });
  }
  return log.reverse();
}

/**
 * Returns audit log entries restricted to the current user's owned SuiteKeys only.
 * Always filters by owned SKs regardless of admin status — used by My SuiteKey Charges.
 */
function getMySkAuditLog() {
  const email = getCurrentUserEmail();
  const owned = getSuiteKeyOwnerKeys(email);
  if (!owned.length) return [];

  const sheet = getTab(TAB_AUDIT);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const log  = [];
  for (let i = 1; i < rows.length; i++) {
    const r  = rows[i];
    const sk = String(r[6]);
    if (!owned.includes(sk)) continue;
    if (!String(r[0])) continue;
    log.push({
      id          : String(r[0]),
      timestamp   : r[1] instanceof Date ? r[1].toISOString() : String(r[1]),
      action      : String(r[2]),
      subId       : String(r[3]),
      licenseName : String(r[4]),
      userEmail   : String(r[5]),
      suiteKey    : sk,
      performedBy : String(r[7]),
      notes       : String(r[8] || ''),
    });
  }
  return log.reverse();
}

// ── PRIVATE HELPERS ───────────────────────────────────────────

/**
 * Looks up the Google Group email for a given license ID.
 */
function _getLicenseGoogleGroup(licenseId) {
  const sheet = getTab(TAB_LICENSES);
  if (!sheet) return '';
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === licenseId) return String(rows[i][17] || '').trim().toLowerCase();
  }
  return '';
}

/**
 * Adds a user to a Google Group. Silently ignores "already a member" errors.
 */
function _addToGoogleGroup(userEmail, groupEmail) {
  if (!userEmail || !groupEmail) return;
  try {
    AdminDirectory.Members.insert({ email: userEmail, role: 'MEMBER' }, groupEmail);
  } catch (e) {
    if (!e.message.includes('Member already exists')) {
      console.error('Failed to add ' + userEmail + ' to ' + groupEmail + ': ' + e.message);
    }
  }
}

/**
 * Removes a user from a Google Group. Silently ignores "not a member" errors.
 */
function _removeFromGoogleGroup(userEmail, groupEmail) {
  if (!userEmail || !groupEmail) return;
  try {
    AdminDirectory.Members.remove(groupEmail, userEmail);
  } catch (e) {
    if (!e.message.toLowerCase().includes('not found') && !e.message.toLowerCase().includes('notfound')) {
      console.error('Failed to remove ' + userEmail + ' from ' + groupEmail + ': ' + e.message);
    }
  }
}

/**
 * Looks up the Activation URL for a given license ID.
 */
function _getLicenseActivationUrl(licenseId) {
  const sheet = getTab(TAB_LICENSES);
  if (!sheet) return '';
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === licenseId) return String(rows[i][14] || '').trim();
  }
  return '';
}

function _getLicenseServiceManager(licenseId) {
  const sheet = getTab(TAB_LICENSES);
  if (!sheet) return '';
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === licenseId) return String(rows[i][19] || '').trim().toLowerCase();
  }
  return '';
}

/**
 * Tells the subscriber their request was approved and seat setup is in progress.
 */
function _notifySubscriberApprovedPending(sub) {
  MailApp.sendEmail({
    to      : sub.userEmail,
    subject : 'License Request Approved — Setup in Progress: ' + sub.licenseName,
    htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#202124">
  <h3 style="color:#1a73e8">License Manager</h3>
  <p>Your request for <strong>${sub.licenseName}</strong> has been approved by the SuiteKey owner.</p>
  <p>The License Manager team is now setting up your account. You will receive another email
     once your access is ready — this may take a few business days.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
    <tr><td style="padding:6px 12px;color:#5f6368;width:120px">License</td>
        <td style="padding:6px 12px"><strong>${sub.licenseName}</strong></td></tr>
    <tr style="background:#f8f9fa">
        <td style="padding:6px 12px;color:#5f6368">SuiteKey</td>
        <td style="padding:6px 12px">${sub.suiteKey}</td></tr>
    <tr><td style="padding:6px 12px;color:#5f6368">Fiscal Year</td>
        <td style="padding:6px 12px">FY${sub.fy}</td></tr>
  </table>
  <p style="color:#5f6368;font-size:13px">Questions? Contact the License Manager team.</p>
</div>`,
  });
}

/**
 * Emails all license managers to provision a seat, including the vendor portal link.
 */
function _notifyAdminsOfPendingActivation(sub, activationUrl) {
  const adminEmails = (getSettingValue('license_manager_emails') || '')
    .split(',').map(e => e.trim()).filter(Boolean);
  const svcMgr = sub.licenseId ? _getLicenseServiceManager(sub.licenseId) : '';
  if (svcMgr && !adminEmails.includes(svcMgr)) adminEmails.push(svcMgr);
  if (!adminEmails.length) return;
  const webAppUrl = getWebAppUrl();
  MailApp.sendEmail({
    to      : adminEmails.join(','),
    subject : 'Action Required: Provision seat — ' + sub.licenseName + ' for ' + sub.userEmail,
    htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#202124">
  <h3 style="color:#1a73e8">License Manager — Seat Provisioning Required</h3>
  <p>A subscription has been approved and is waiting for you to provision the seat on the vendor side.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
    <tr><td style="padding:6px 12px;color:#5f6368;width:120px">User</td>
        <td style="padding:6px 12px"><strong>${sub.userEmail}</strong></td></tr>
    <tr style="background:#f8f9fa">
        <td style="padding:6px 12px;color:#5f6368">License</td>
        <td style="padding:6px 12px">${sub.licenseName}</td></tr>
    <tr><td style="padding:6px 12px;color:#5f6368">SuiteKey</td>
        <td style="padding:6px 12px">${sub.suiteKey}</td></tr>
    <tr style="background:#f8f9fa">
        <td style="padding:6px 12px;color:#5f6368">Fiscal Year</td>
        <td style="padding:6px 12px">FY${sub.fy}</td></tr>
  </table>
  <p style="margin:20px 0">
    <a href="${activationUrl}" style="background:#1a73e8;color:#fff;padding:12px 24px;border-radius:4px;
       text-decoration:none;font-weight:bold;display:inline-block">Open Vendor Portal →</a>
  </p>
  <p style="color:#5f6368;font-size:13px">
    Once the seat is provisioned, mark it as activated in
    <a href="${webAppUrl}" style="color:#1a73e8">License Manager → Admin → All Subscriptions</a>.
    The user will be notified automatically.
  </p>
</div>`,
  });
}

/**
 * Tells the subscriber their seat has been provisioned and they're ready to go.
 */
function _notifyUserOfActivation(sub) {
  MailApp.sendEmail({
    to      : sub.userEmail,
    subject : 'Your ' + sub.licenseName + ' account is ready!',
    htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#202124">
  <h3 style="color:#1a73e8">License Manager</h3>
  <p>Your <strong>${sub.licenseName}</strong> account has been set up and is ready to use.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
    <tr><td style="padding:6px 12px;color:#5f6368;width:120px">License</td>
        <td style="padding:6px 12px"><strong>${sub.licenseName}</strong></td></tr>
    <tr style="background:#f8f9fa">
        <td style="padding:6px 12px;color:#5f6368">SuiteKey</td>
        <td style="padding:6px 12px">${sub.suiteKey}</td></tr>
    <tr><td style="padding:6px 12px;color:#5f6368">Fiscal Year</td>
        <td style="padding:6px 12px">FY${sub.fy}</td></tr>
  </table>
  <p style="color:#5f6368;font-size:13px">Questions? Contact the License Manager team.</p>
</div>`,
  });
}

/**
 * Appends one row to the AuditLog sheet.
 */
function _getOrCreateAuditSheet() {
  let sheet = getTab(TAB_AUDIT);
  if (sheet) return sheet;
  const ss = getAppSpreadsheet();
  if (!ss) return null;
  sheet = ss.insertSheet(TAB_AUDIT);
  sheet.appendRow(['ID', 'Timestamp', 'Action', 'SubscriptionID', 'LicenseName', 'UserEmail', 'SuiteKey', 'PerformedBy', 'Notes']);
  sheet.getRange(1, 1, 1, 9).setFontWeight('bold').setBackground('#e8f0fe');
  return sheet;
}

function _logAuditEvent(action, sub, performedBy, notes) {
  try {
    const sheet = _getOrCreateAuditSheet();
    if (!sheet) return;
    sheet.appendRow([
      generateId('AUD'),
      new Date(),
      action,
      sub.id          || '',
      sub.licenseName || '',
      sub.userEmail   || '',
      sub.suiteKey    || '',
      performedBy     || '',
      notes           || '',
    ]);
  } catch (e) {
    console.error('_logAuditEvent failed: ' + e.message);
  }
}

/**
 * Emails the subscriber when their request is approved, declined, or revoked.
 * For declined requests, includes the owner's email and optional reason.
 */
function _notifyAdminsOfCancellation(sub, reason, performedBy, note) {
  const adminEmails = (getSettingValue('license_manager_emails') || '')
    .split(',').map(e => e.trim()).filter(Boolean);
  if (!adminEmails.length) return;
  const webAppUrl = getWebAppUrl();
  MailApp.sendEmail({
    to      : adminEmails.join(','),
    subject : 'Subscription ' + reason + ': ' + sub.licenseName + ' — ' + sub.userEmail,
    htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#202124">
  <h3 style="color:#c5221f">License Manager — Subscription ${reason}</h3>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
    <tr><td style="padding:6px 12px;color:#5f6368;width:120px">User</td>
        <td style="padding:6px 12px"><strong>${sub.userEmail}</strong></td></tr>
    <tr style="background:#f8f9fa">
        <td style="padding:6px 12px;color:#5f6368">License</td>
        <td style="padding:6px 12px">${sub.licenseName}</td></tr>
    <tr><td style="padding:6px 12px;color:#5f6368">SuiteKey</td>
        <td style="padding:6px 12px">${sub.suiteKey}</td></tr>
    <tr style="background:#f8f9fa">
        <td style="padding:6px 12px;color:#5f6368">Fiscal Year</td>
        <td style="padding:6px 12px">FY${sub.fy}</td></tr>
    <tr><td style="padding:6px 12px;color:#5f6368">Performed by</td>
        <td style="padding:6px 12px">${performedBy}</td></tr>
    ${note ? `<tr style="background:#f8f9fa"><td style="padding:6px 12px;color:#5f6368">Note</td>
        <td style="padding:6px 12px">${note}</td></tr>` : ''}
  </table>
  <p style="color:#5f6368;font-size:13px">
    View in <a href="${webAppUrl}" style="color:#1a73e8">License Manager → Admin → All Subscriptions</a>.
  </p>
</div>`,
  });
}

function _notifySubscriberOfDecision(sub, action, performedBy, reason) {
  let subject, bodyHtml;

  if (action === 'approved') {
    subject  = 'License Request Approved: ' + sub.licenseName;
    bodyHtml = `<p>Your request for <strong>${sub.licenseName}</strong> has been approved.
                Your subscription is now active.</p>`;

  } else if (action === 'declined') {
    subject = 'License Request Declined: ' + sub.licenseName;
    const reasonBlock = reason
      ? `<div style="background:#fce8e6;border-left:4px solid #c5221f;border-radius:4px;
                     padding:10px 14px;margin:16px 0;font-size:14px">
           <strong style="color:#c5221f">Reason given:</strong><br>${reason}
         </div>`
      : '';
    bodyHtml = `
<p>Your request for <strong>${sub.licenseName}</strong> has been declined.</p>
${reasonBlock}
<p style="font-size:13px;color:#5f6368">
  Declined by SuiteKey owner:
  <a href="mailto:${performedBy}" style="color:#1a73e8">${performedBy}</a><br>
  If you have questions, you can reply directly to the owner.
</p>`;

  } else if (action === 'revoked') {
    subject  = 'License Subscription Revoked: ' + sub.licenseName;
    bodyHtml = `<p>Your subscription to <strong>${sub.licenseName}</strong> has been revoked by
                the SuiteKey owner (<a href="mailto:${performedBy}" style="color:#1a73e8">${performedBy}</a>).</p>`
             + `<p style="font-size:13px;color:#5f6368">Questions? Contact
                <a href="mailto:${performedBy}" style="color:#1a73e8">${performedBy}</a>.</p>`;

  } else {
    return;
  }

  try {
    MailApp.sendEmail({
      to      : sub.userEmail,
      subject,
      htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#202124">
  <h3 style="color:#1a73e8">License Manager</h3>
  ${bodyHtml}
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
    <tr><td style="padding:6px 12px;color:#5f6368;width:120px">License</td>
        <td style="padding:6px 12px"><strong>${sub.licenseName}</strong></td></tr>
    <tr style="background:#f8f9fa">
        <td style="padding:6px 12px;color:#5f6368">SuiteKey</td>
        <td style="padding:6px 12px">${sub.suiteKey}</td></tr>
    <tr><td style="padding:6px 12px;color:#5f6368">Fiscal Year</td>
        <td style="padding:6px 12px">FY${sub.fy}</td></tr>
  </table>
  ${action !== 'revoked' && action !== 'declined'
    ? '<p style="color:#5f6368;font-size:13px">Questions? Contact the License Manager team.</p>'
    : ''}
</div>`,
    });
  } catch (e) {
    console.error('_notifySubscriberOfDecision failed for ' + sub.userEmail + ': ' + e.message);
  }
}
