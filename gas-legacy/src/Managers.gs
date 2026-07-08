// ============================================================
//  MANAGERS — manager (people) and SuiteKey-owner views
// ============================================================

/**
 * Returns subscriptions for all direct and indirect reports
 * of the current user. Reads the staff hierarchy sheet to
 * build the full list of reports recursively.
 */
function getTeamSubscriptions() {
  const email = getCurrentUserEmail();
  if (!isOrgManager(email)) throw new Error('Access denied: not a people manager.');

  const reports = getReportEmails(email);
  if (reports.length === 0) return [];

  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const subs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[7]) === 'cancelled') continue;
    if (!reports.includes(String(r[1]).toLowerCase())) continue;
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
  return subs;
}

/**
 * Returns all non-cancelled subscriptions charged to ANY SuiteKey owned
 * by the current user, across all owned keys at once.
 */
function getAllSuiteKeyCharges() {
  const email = getCurrentUserEmail();
  const owned = getSuiteKeyOwnerKeys(email);
  if (!owned.length) return [];

  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const subs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!owned.includes(String(r[4]))) continue;
    if (String(r[7]) === 'cancelled') continue;
    subs.push({
      id          : String(r[0]),
      userEmail   : String(r[1]),
      licenseName : String(r[2]),
      suiteKey    : String(r[4]),
      startDate   : r[5] instanceof Date ? r[5].toISOString().split('T')[0] : String(r[5]),
      fy          : Number(r[6]),
      status      : String(r[7]),
    });
  }
  return subs;
}

/**
 * Returns all active subscriptions being charged to a given SuiteKey.
 * Only the SuiteKey owner (as defined in the permissions sheet) may call this.
 */
function getSuiteKeyCharges(suiteKey) {
  const email = getCurrentUserEmail();
  const owned = getSuiteKeyOwnerKeys(email);
  if (!owned.includes(suiteKey)) {
    throw new Error('You do not own SuiteKey: ' + suiteKey);
  }

  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const subs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[4]) !== suiteKey) continue;
    if (String(r[7]) === 'cancelled') continue;
    subs.push({
      id          : String(r[0]),
      userEmail   : String(r[1]),
      licenseName : String(r[2]),
      suiteKey    : String(r[4]),
      startDate   : r[5] instanceof Date ? r[5].toISOString().split('T')[0] : String(r[5]),
      fy          : Number(r[6]),
      status      : String(r[7]),
    });
  }
  return subs;
}

/**
 * Returns all SuiteKeys from the permissions sheet with their owner and description.
 * Admin only.
 */
function getSuiteKeyList() {
  requireLicenseManager();
  const perm = getPermissionsData();
  if (!perm.data) return [];

  // Build set of SKs that have any pending_sk_verification subscriptions
  const pendingSkSet = new Set();
  const subSheet = getTab(TAB_SUBSCRIPTIONS);
  if (subSheet) {
    const subRows = subSheet.getDataRange().getValues();
    for (let i = 1; i < subRows.length; i++) {
      if (String(subRows[i][7]) === 'pending_sk_verification') {
        pendingSkSet.add(String(subRows[i][4]).trim());
      }
    }
  }

  const results = [];
  for (let i = 1; i < perm.data.length; i++) {
    const row = perm.data[i];
    const sk  = String(row[0] || '').trim();
    if (!sk) continue;
    const owner = String(row[2] || '').trim().toLowerCase();
    results.push({
      suiteKey    : sk,
      owner,
      description : String(row[4] || '').trim(),
      ownerStatus : !owner ? 'unassigned' : pendingSkSet.has(sk) ? 'pending' : 'confirmed',
    });
  }
  return results;
}

/**
 * Updates the owner of a SuiteKey in the permissions sheet and clears the cache.
 * Admin only.
 */
function updateSuiteKeyOwner(suiteKey, newOwnerEmail) {
  requireLicenseManager();
  suiteKey      = String(suiteKey      || '').trim();
  newOwnerEmail = String(newOwnerEmail || '').trim().toLowerCase();
  if (!suiteKey)      throw new Error('SuiteKey is required.');
  if (newOwnerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newOwnerEmail)) {
    throw new Error('Invalid email address.');
  }

  const sp     = PropertiesService.getScriptProperties();
  const permId = sp.getProperty(SPROP_PERMISSIONS_ID);
  if (!permId) throw new Error('Permissions sheet not configured.');

  const permSS    = SpreadsheetApp.openById(permId);
  const permSheet = permSS.getSheetByName(PERM_TAB_SUITEKEYS) || permSS.getSheets()[0];
  const rows      = permSheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === suiteKey) {
      permSheet.getRange(i + 1, 3).setValue(newOwnerEmail);
      sp.deleteProperty(SPROP_PERMISSIONS_CACHE);

      if (newOwnerEmail) {
        // Re-point any pending_sk_verification subs for this SK to the new owner
        const subSheet = getTab(TAB_SUBSCRIPTIONS);
        if (subSheet) {
          const subRows = subSheet.getDataRange().getValues();
          for (let j = 1; j < subRows.length; j++) {
            if (String(subRows[j][4]) === suiteKey && String(subRows[j][7]) === 'pending_sk_verification') {
              subSheet.getRange(j + 1, 13).setValue(newOwnerEmail);
            }
          }
        }

        // Send ownership confirmation email with Yes/No buttons
        try {
          const webAppUrl  = getWebAppUrl();
          const confirmUrl = webAppUrl + '?action=confirm_sk_owner_all&sk=' + encodeURIComponent(suiteKey);
          const denyUrl    = webAppUrl + '?action=deny_sk_owner_all&sk='    + encodeURIComponent(suiteKey);
          MailApp.sendEmail({
            to      : newOwnerEmail,
            subject : 'Action Required: SuiteKey Ownership Confirmation — ' + suiteKey,
            htmlBody: `
<div style="font-family:Arial,sans-serif;max-width:600px;color:#202124">
  <h3 style="color:#1a73e8">License Manager — SuiteKey Ownership</h3>
  <p>You have been designated as the budget manager for SuiteKey <strong>${suiteKey}</strong>
     in License Manager. Please confirm or deny your ownership so any pending license requests can proceed.</p>
  <p>Are you the budget manager for SuiteKey <strong>${suiteKey}</strong>?</p>
  <div style="margin:24px 0">
    <a href="${confirmUrl}" style="background:#137333;color:#fff;padding:12px 28px;border-radius:4px;
       text-decoration:none;font-weight:bold;display:inline-block;margin-right:12px">&#10003; Yes, I manage it</a>
    <a href="${denyUrl}" style="background:#c5221f;color:#fff;padding:12px 28px;border-radius:4px;
       text-decoration:none;font-weight:bold;display:inline-block">&#10007; No, I don't</a>
  </div>
  <p style="color:#5f6368;font-size:13px">
    If you confirm, you will be registered as the SuiteKey owner and any pending license requests
    will move to your approval queue in
    <a href="${webAppUrl}" style="color:#1a73e8">License Manager</a>.
  </p>
</div>`,
          });
        } catch (e) {
          console.error('SK owner confirmation email failed: ' + e.message);
        }
      }
      return { ok: true };
    }
  }
  throw new Error('SuiteKey not found: ' + suiteKey);
}

/**
 * Returns the Ministry ID for the current user, or null if not on file.
 * No auth required — called as part of getInitialData.
 */
function getMyMinistryId() {
  const email = getCurrentUserEmail();
  if (!email) return null;
  const data  = getMinistryData();
  if (!data)  return null;
  const lower = email.toLowerCase();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim().toLowerCase() === lower) {
      return String(data[i][1] || '').trim() || null;
    }
  }
  return null;
}

/**
 * Returns all Ministry IDs. Admin only.
 */
function getMinistryIdList() {
  requireLicenseManager();
  const data = getMinistryData();
  if (!data) return [];
  const results = [];
  for (let i = 1; i < data.length; i++) {
    const email = String(data[i][0] || '').trim().toLowerCase();
    const id    = String(data[i][1] || '').trim();
    if (email) results.push({ email, ministryId: id });
  }
  return results;
}

/**
 * Admin: add or update a Ministry ID for a given email.
 * Passing an empty ministryId clears the entry.
 */
function updateMinistryId(email, ministryId) {
  requireLicenseManager();
  email      = String(email      || '').trim().toLowerCase();
  ministryId = String(ministryId || '').trim();
  if (!email) throw new Error('Email is required.');
  if (ministryId && !/^\d{6}$/.test(ministryId)) throw new Error('Ministry ID must be exactly 6 digits.');

  const sp     = PropertiesService.getScriptProperties();
  const permId = sp.getProperty(SPROP_PERMISSIONS_ID);
  if (!permId) throw new Error('Permissions sheet not configured.');

  const sheet = SpreadsheetApp.openById(permId).getSheetByName(PERM_TAB_MINISTRY_IDS);
  if (!sheet) throw new Error('"Ministry IDs" tab not found in the permissions spreadsheet.');

  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim().toLowerCase() === email) {
      if (ministryId) {
        sheet.getRange(i + 1, 2).setValue(ministryId);
      } else {
        sheet.deleteRow(i + 1);
      }
      sp.deleteProperty(SPROP_MINISTRY_IDS_CACHE);
      return { ok: true, action: ministryId ? 'updated' : 'deleted' };
    }
  }
  if (!ministryId) return { ok: true, action: 'noop' };
  sheet.appendRow([email, ministryId]);
  sp.deleteProperty(SPROP_MINISTRY_IDS_CACHE);
  return { ok: true, action: 'created' };
}

/**
 * Walks the hierarchy sheet recursively to collect all emails
 * that report (directly or indirectly) to managerEmail.
 *
 * Hierarchy sheet assumed format:
 *   Col A = Email
 *   Col B = Name
 *   Col C = ManagerEmail
 *   Col D = Department (optional)
 */
function getReportEmails(managerEmail) {
  const hier = getHierarchyData();
  if (!hier) return [];

  const lower   = managerEmail.toLowerCase();
  const reports = new Set();
  const queue   = [lower];

  while (queue.length > 0) {
    const mgr = queue.shift();
    for (let i = 1; i < hier.length; i++) {
      const rowEmail = String(hier[i][0] || '').trim().toLowerCase();  // col A
      const rowMgr   = String(hier[i][1] || '').trim().toLowerCase();  // col B
      if (rowMgr === mgr && rowEmail && !reports.has(rowEmail)) {
        reports.add(rowEmail);
        queue.push(rowEmail);
      }
    }
  }
  return [...reports];
}

/**
 * Returns the department name for a given email from the hierarchy sheet,
 * or an empty string if not found or column is absent.
 */
function getDepartmentForEmail(email) {
  const hier = getHierarchyData();
  if (!hier) return '';
  const lower = email.toLowerCase();
  for (let i = 1; i < hier.length; i++) {
    if (String(hier[i][0] || '').trim().toLowerCase() === lower) {
      return String(hier[i][3] || '').trim(); // col D = Department
    }
  }
  return '';
}
