// ============================================================
//  CATALOG — license product CRUD (License Manager admins only)
//
//  Every function calls requireLicenseManager() at the top.
// ============================================================

/**
 * Returns all licenses from the catalog.
 * includeInactive = true shows deactivated licenses too.
 */
function getLicenses(includeInactive) {
  requireLicenseManager();
  const sheet = getTab(TAB_LICENSES);
  if (!sheet) return [];
  const rows     = sheet.getDataRange().getValues();
  const licenses = [];
  for (let i = 1; i < rows.length; i++) {
    const r      = rows[i];
    const active = r[7] === true || String(r[7]).toLowerCase() === 'true';
    if (!includeInactive && !active) continue;
    licenses.push({
      id            : String(r[0]),
      name          : String(r[1]),
      vendor        : String(r[2]),
      category      : String(r[3]),
      price         : Number(r[4]) || 0,
      priceUnit     : String(r[5]),
      notes         : String(r[6]),
      active,
      gtisSponsored : r[8] === true || String(r[8] || '').toLowerCase() === 'true',
      billingCycle  : String(r[9] || 'annual').toLowerCase(),
      renewalMonth  : Number(r[10]) || 0,
      renewalReminder: r[11] === true || String(r[11] || '').toLowerCase() === 'true',
      createdBy     : String(r[12] || ''),
      logoUrl       : String(r[13] || ''),
      activationUrl : String(r[14] || ''),
      activated     : r[15] === true || String(r[15] || '').toLowerCase() === 'true',
      moreInfoUrl      : String(r[16] || ''),
      googleGroupEmail : String(r[17] || ''),
      proRated         : r[18] === true || String(r[18] || '').toLowerCase() === 'true',
      serviceManager   : String(r[19] || '').trim().toLowerCase(),
      rowIndex         : i + 1,
    });
  }
  return licenses;
}

/**
 * Creates or updates a license in the catalog.
 * If license.id matches an existing row it is updated in-place;
 * otherwise a new row is appended and a generated ID is assigned.
 */
function saveLicense(license) {
  requireLicenseManager();
  const sheet = getTab(TAB_LICENSES);
  if (!sheet) throw new Error('Licenses tab not found.');
  const rows = sheet.getDataRange().getValues();

  const currentUser = getCurrentUserEmail();
  const id     = String(license.id || '').trim() || generateId('LIC');
  const active = license.active !== false;
  const row = [
    id,
    String(license.name      || '').trim(),
    String(license.vendor    || '').trim(),
    String(license.category  || '').trim(),
    Number(license.price)    || 0,
    String(license.priceUnit || 'per seat/year').trim(),
    String(license.notes     || '').trim(),
    active,
    license.gtisSponsored === true,
    String(license.billingCycle || 'annual').toLowerCase(),
    Number(license.renewalMonth) || 0,
    license.renewalReminder === true,
    license.id ? String(license.createdBy || '') : currentUser,
    String(license.logoUrl       || '').trim(),
    String(license.activationUrl || '').trim(),
    license.activated === true,
    String(license.moreInfoUrl      || '').trim(),
    String(license.googleGroupEmail || '').trim().toLowerCase(),
    license.proRated === true,
    String(license.serviceManager || '').trim().toLowerCase(),
  ];

  const saved = {
    id: row[0], name: row[1], vendor: row[2], category: row[3],
    price: row[4], priceUnit: row[5], notes: row[6], active: row[7],
    gtisSponsored: row[8], billingCycle: row[9], renewalMonth: row[10],
    renewalReminder: row[11], createdBy: row[12], logoUrl: row[13],
    activationUrl: row[14], activated: row[15], moreInfoUrl: row[16],
    googleGroupEmail: row[17], proRated: row[18], serviceManager: row[19],
  };

  if (license.id) {
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === String(license.id)) {
        sheet.getRange(i + 1, 1, 1, 20).setValues([row]);
        return { ok: true, id, action: 'updated', license: saved };
      }
    }
  }

  sheet.appendRow(row);
  return { ok: true, id, action: 'created', license: saved };
}

/**
 * Soft-deletes a license by setting Active = false.
 * Existing subscriptions are unaffected; no new subscriptions
 * can be created for an inactive license.
 */
function deactivateLicense(licenseId) {
  requireLicenseManager();
  const currentUser = getCurrentUserEmail();
  const sheet = getTab(TAB_LICENSES);
  if (!sheet) throw new Error('Licenses tab not found.');
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(licenseId)) {
      const createdBy = String(rows[i][12] || '').toLowerCase();
      if (createdBy && createdBy !== currentUser) {
        throw new Error('You can only deactivate licenses you created.');
      }
      sheet.getRange(i + 1, 8).setValue(false);
      return { ok: true };
    }
  }
  throw new Error('License not found: ' + licenseId);
}

function getFinanceExport(startDateStr, endDateStr) {
  requireLicenseManager();

  const startTs = startDateStr ? new Date(startDateStr).getTime()             : 0;
  const endTs   = endDateStr   ? new Date(endDateStr + 'T23:59:59').getTime() : 9007199254740991;

  // Build license lookup: licenseId -> pricing metadata
  const licSheet = getTab(TAB_LICENSES);
  const licRows  = licSheet ? licSheet.getDataRange().getValues() : [];
  const licMap   = {};
  for (let i = 1; i < licRows.length; i++) {
    const r = licRows[i];
    licMap[String(r[0])] = {
      price        : Number(r[4]) || 0,
      billingCycle : String(r[9] || 'annual').toLowerCase(),
      renewalMonth : Number(r[10]) || 0,
      proRated     : r[18] === true || String(r[18] || '').toLowerCase() === 'true',
    };
  }

  const subSheet = getTab(TAB_SUBSCRIPTIONS);
  if (!subSheet) return [];
  const subRows = subSheet.getDataRange().getValues();

  const result = [];
  for (let i = 1; i < subRows.length; i++) {
    const r      = subRows[i];
    const status = String(r[7]);
    if (status !== 'active' && status !== 'approved') continue;

    const rawDate = r[5];
    const subDate = rawDate instanceof Date ? rawDate : new Date(rawDate);
    if (isNaN(subDate.getTime())) continue;
    const subTs = subDate.getTime();
    if (subTs < startTs || subTs > endTs) continue;

    const lic  = licMap[String(r[3])] || { price: 0, billingCycle: 'annual', renewalMonth: 0, proRated: false };
    const cost = _calcProRatedCost(lic, subDate);

    result.push({
      userEmail    : String(r[1]),
      licenseName  : String(r[2]),
      suiteKey     : String(r[4]),
      cost,
      dateRequested: subDate.toISOString().split('T')[0],
      status,
    });
  }
  return result;
}

function _calcProRatedCost(lic, startDate) {
  if (!lic.proRated) return lic.price;
  if (lic.billingCycle === 'monthly') {
    // Day-based: days remaining in the month, inclusive of start day
    const day      = startDate.getDate();
    const daysInMo = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();
    const daysLeft = daysInMo - day + 1;
    return Math.round(lic.price * (daysLeft / daysInMo) * 100) / 100;
  }
  // Annual: months remaining from startDate to next occurrence of renewalMonth (1-12)
  const renewMonth = lic.renewalMonth || 10; // default October (FY)
  const startMonth = startDate.getMonth() + 1; // 1-12
  let months = renewMonth - startMonth;
  if (months <= 0) months += 12;
  return Math.round(lic.price * (months / 12) * 100) / 100;
}

/**
 * Bulk-imports already-active subscriptions from a legacy system.
 * Creates each row with status = 'active' immediately.
 * No approval emails, no SK verification, no Google Group changes.
 * Skips rows where the user already has an active/pending sub for the same license+FY.
 *
 * Each row: { userEmail, licenseName, suiteKey, startDate (optional), fy (optional) }
 * Returns an array of { ok, id, error, row } objects — one per input row.
 */
function importSubscriptions(rows) {
  requireLicenseManager();

  const licSheet = getTab(TAB_LICENSES);
  const licRows  = licSheet ? licSheet.getDataRange().getValues() : [];

  // Build lookup by lowercase name and by ID
  const licMap = {};
  for (let i = 1; i < licRows.length; i++) {
    const r      = licRows[i];
    const active = r[7] === true || String(r[7]).toLowerCase() === 'true';
    if (!active) continue;
    const entry = {
      id             : String(r[0]),
      name           : String(r[1]),
      billingCycle   : String(r[9] || 'annual').toLowerCase(),
      renewalMonth   : Number(r[10]) || 0,
      renewalReminder: r[11] === true || String(r[11] || '').toLowerCase() === 'true',
    };
    licMap[entry.name.toLowerCase()] = entry;
    licMap[entry.id.toLowerCase()]   = entry;
  }

  const subSheet     = getTab(TAB_SUBSCRIPTIONS);
  if (!subSheet) throw new Error('Subscriptions tab not found.');
  const existingRows = subSheet.getDataRange().getValues();

  // Track existing active/pending subs to prevent duplicates: "email|licId|fy"
  const existingSet = new Set();
  for (let i = 1; i < existingRows.length; i++) {
    const r = existingRows[i];
    const s = String(r[7]);
    if (['active', 'approved', 'pending', 'pending_sk_verification'].includes(s)) {
      existingSet.add(String(r[1]).toLowerCase() + '|' + String(r[3]) + '|' + String(r[6]));
    }
  }

  const currentFY  = getCurrentFiscalYear();
  const adminEmail = getCurrentUserEmail();
  const results    = [];

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    try {
      const userEmail  = String(row.userEmail   || '').trim().toLowerCase();
      const licKey     = String(row.licenseName || '').trim().toLowerCase();
      let   suiteKey   = String(row.suiteKey    || '').trim();

      if (!userEmail)                               { results.push({ row, ok: false, error: 'Missing email' });        continue; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) { results.push({ row, ok: false, error: 'Invalid email' }); continue; }
      if (!ALLOWED_DOMAINS.includes((userEmail.split('@')[1] || '').toLowerCase())) { results.push({ row, ok: false, error: 'Domain not eligible: ' + (userEmail.split('@')[1] || '') }); continue; }
      if (!licKey)                                  { results.push({ row, ok: false, error: 'Missing license name' }); continue; }
      if (!suiteKey)                                { results.push({ row, ok: false, error: 'Missing SuiteKey or Ministry ID' }); continue; }

      // Normalize Ministry IDs: bare 6 digits or MIN:XXXXXX → MIN:XXXXXX
      const isMinistry = /^\d{6}$/.test(suiteKey) || /^MIN:\d{6}$/i.test(suiteKey);
      if (isMinistry) {
        const digits = suiteKey.replace(/^MIN:/i, '');
        if (!/^\d{6}$/.test(digits)) { results.push({ row, ok: false, error: 'Ministry ID must be exactly 6 digits' }); continue; }
        suiteKey = 'MIN:' + digits;
      }

      const lic = licMap[licKey];
      if (!lic) { results.push({ row, ok: false, error: 'License not found in catalog: ' + row.licenseName }); continue; }

      const fy        = Number(row.fy) || currentFY;
      const startDate = row.startDate ? new Date(row.startDate) : new Date();
      if (isNaN(startDate.getTime())) { results.push({ row, ok: false, error: 'Invalid start date' }); continue; }

      const dupKey = userEmail + '|' + lic.id + '|' + String(fy);
      if (existingSet.has(dupKey)) {
        results.push({ row, ok: false, error: 'Already has an active subscription for FY' + fy }); continue;
      }

      const newId = generateId('SUB');
      subSheet.appendRow([
        newId, userEmail, lic.name, lic.id, suiteKey,
        startDate, fy, 'active', '', lic.billingCycle,
        lic.renewalMonth || '', lic.renewalReminder, '', lic.price || 0,
      ]);
      if (isMinistry) {
        try { _saveMinistryId(userEmail, suiteKey.slice(4)); } catch (_) {}
      }
      _logAuditEvent('imported', {
        id: newId, userEmail, licenseName: lic.name, suiteKey, fy,
      }, adminEmail, 'imported from legacy system');

      existingSet.add(dupKey);
      results.push({ row, ok: true, id: newId });
    } catch (e) {
      results.push({ row, ok: false, error: e.message });
    }
  }
  return results;
}

/**
 * Returns every subscription row (all users, all statuses).
 * Used in the Admin Panel all-subscriptions table.
 */
function getAllSubscriptions() {
  requireLicenseManager();
  const sheet = getTab(TAB_SUBSCRIPTIONS);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const subs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!String(r[0])) continue; // skip blank rows
    subs.push({
      id             : String(r[0]),
      userEmail      : String(r[1]),
      licenseName    : String(r[2]),
      licenseId      : String(r[3]),
      suiteKey       : String(r[4]),
      startDate      : r[5] instanceof Date ? r[5].toISOString().split('T')[0] : String(r[5]),
      fy             : Number(r[6]),
      status         : String(r[7]),
      renewalStatus  : String(r[8] || ''),
      billingCycle   : String(r[9] || 'annual'),
      renewalMonth   : Number(r[10]) || 0,
      renewalReminder: r[11] === true || String(r[11] || '').toLowerCase() === 'true',
    });
  }
  return subs;
}
