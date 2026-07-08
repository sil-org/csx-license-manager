// ============================================================
//  LICENSE MANAGER — Google Apps Script Web App
//
//  ARCHITECTURE
//  ─────────────────────────────────────────────────────────
//  Deploy as:  Execute as = Me (script owner)
//              Who has access = Anyone in your organization
//
//  Running as the owner means the staff hierarchy sheet (shared
//  only with the script owner) is never accessible to end users.
//  Session.getActiveUser().getEmail() still returns the actual
//  requesting user's email even in this mode.
//
//  ScriptProperties (set once by admin via Admin Panel)
//    APP_SHEET_ID          Spreadsheet ID of this app's data sheet
//    PERMISSIONS_SHEET_ID  Same permissions sheet as Budget Tracker
//    PERMISSIONS_CACHE     JSON-cached permissions data (refreshed by admin)
//    HIERARCHY_SHEET_ID    Staff hierarchy sheet (owner-access only)
//
//  App Spreadsheet tabs
//    Licenses      Software product catalog
//    Subscriptions Active and historical subscriptions
//    Renewals      FY renewal opt-ins
//    Settings      License manager emails, config
//
//  Permissions sheet layout (Budget Tracker format)
//    Col A  SuiteKey        e.g. WaxhawIT-U_SIL
//    Col B  Viewer emails   comma-separated
//    Col C  Owner email     single email
//
//  Staff hierarchy sheet layout (assumed)
//    Col A  Email
//    Col B  Name
//    Col C  ManagerEmail
//    Col D  Department (optional)
// ============================================================


// ── CONSTANTS ────────────────────────────────────────────────

const FISCAL_YEAR_START_MONTH = 10; // October

const SPROP_APP_SHEET_ID         = 'APP_SHEET_ID';
const SPROP_PERMISSIONS_ID       = 'PERMISSIONS_SHEET_ID';
const SPROP_PERMISSIONS_CACHE    = 'PERMISSIONS_CACHE';
const SPROP_MINISTRY_IDS_CACHE   = 'MINISTRY_IDS_CACHE';
const SPROP_HIERARCHY_ID         = 'HIERARCHY_SHEET_ID';

const PERM_TAB_SUITEKEYS    = 'SuiteKeys';
const PERM_TAB_MINISTRY_IDS = 'Ministry IDs';

const TAB_LICENSES      = 'Licenses';
const TAB_SUBSCRIPTIONS = 'Subscriptions';
const TAB_RENEWALS      = 'Renewals';
const TAB_SETTINGS      = 'Settings';
const TAB_AUDIT         = 'AuditLog';

const ALLOWED_DOMAINS = [
  'email7.net',
  'hipaa.sil.org',
  'ethnologue.com',
  'i55seed.com',
  'koastal.net',
  'mailrapide.com',
  'pike34.net',
  'sall.com',
  'scriptsource.org',
  'sil.org',
  'spbangladesh.org',
];

// ── EXECUTION-SCOPED CACHE ───────────────────────────────────
// Reset on every server call — prevents redundant sheet reads
// within a single request.

let _permData      = undefined;
let _ministryData  = undefined;
let _hierarchyData = undefined;
let _appSS         = undefined;


// ============================================================
//  WEB APP ENTRY POINT
// ============================================================

/**
 * Serves the License Manager as a web app.
 * Deploy as: Execute as = Me (script owner)
 *            Who has access = Anyone in your organization
 */
function doGet(e) {
  // Auto-cache the deployed URL so email links always have a valid base.
  try {
    const url = ScriptApp.getService().getUrl();
    if (url) PropertiesService.getScriptProperties().setProperty('WEB_APP_URL', url);
  } catch (_) {}

  const action = e && e.parameter && e.parameter.action;
  if ((action === 'approve' || action === 'decline') && e.parameter.subId) {
    return _handleApprovalLink(action, e.parameter.subId);
  }
  if ((action === 'opt_in_renewal' || action === 'opt_out_renewal') && e.parameter.subId) {
    return _handleRenewalResponse(action, e.parameter.subId);
  }
  if ((action === 'confirm_sk_owner' || action === 'deny_sk_owner') && e.parameter.subId) {
    return _handleSkVerification(action, e.parameter.subId);
  }
  if ((action === 'confirm_sk_owner_all' || action === 'deny_sk_owner_all') && e.parameter.sk) {
    return _handleSkVerificationAll(action, e.parameter.sk);
  }
  const template = HtmlService.createTemplateFromFile('Index');
  template.renewMode = (e && e.parameter && e.parameter.renew === 'true') ? 'true' : 'false';
  return template.evaluate()
    .setTitle('License Manager')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function _handleRenewalResponse(action, subId) {
  let title, message, isSuccess = false;
  try {
    if (action === 'opt_in_renewal') {
      optInRenewal(subId, null);
      title   = 'Renewal Confirmed';
      message = 'Your subscription has been marked for renewal. No further reminders will be sent.';
    } else {
      optOutRenewal(subId);
      title   = 'Renewal Declined';
      message = 'You\'ve indicated you will not be renewing this subscription. No further reminders will be sent.';
    }
    isSuccess = true;
  } catch (ex) {
    title   = 'Action Failed';
    message = ex.message;
  }
  const color = isSuccess ? '#137333' : '#c5221f';
  const icon  = isSuccess ? '✓' : '✗';
  return HtmlService.createHtmlOutput(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${title}</title>
<style>body{font-family:'Google Sans',Arial,sans-serif;max-width:480px;margin:80px auto;
text-align:center;color:#202124;padding:0 16px}
h2{color:${color}}p{color:#5f6368;font-size:14px;line-height:1.7}a{color:#1a73e8}</style>
</head><body>
<h2>${icon} ${title}</h2><p>${message}</p>
<p><a href="${getWebAppUrl()}">Return to License Manager</a></p>
</body></html>`)
    .setTitle(title)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function _handleSkVerification(action, subId) {
  let title, message, isSuccess = false;
  try {
    if (action === 'confirm_sk_owner') {
      confirmSkOwnership(subId);
      title   = 'Ownership Confirmed';
      message = 'Thank you! You have been added as the SuiteKey owner and the license request is now pending your approval — check your email for the approval request.';
    } else {
      denySkOwnership(subId);
      title   = 'Ownership Denied';
      message = 'Thank you for responding. The requestor has been notified that the SuiteKey owner could not be confirmed.';
    }
    isSuccess = true;
  } catch (ex) {
    title   = 'Action Failed';
    message = ex.message;
  }
  const color = isSuccess ? '#137333' : '#c5221f';
  const icon  = isSuccess ? '✓' : '✗';
  return HtmlService.createHtmlOutput(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${title}</title>
<style>body{font-family:'Google Sans',Arial,sans-serif;max-width:480px;margin:80px auto;
text-align:center;color:#202124;padding:0 16px}
h2{color:${color}}p{color:#5f6368;font-size:14px;line-height:1.7}a{color:#1a73e8}</style>
</head><body>
<h2>${icon} ${title}</h2><p>${message}</p>
<p><a href="${getWebAppUrl()}">Return to License Manager</a></p>
</body></html>`)
    .setTitle(title)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function _handleSkVerificationAll(action, suiteKey) {
  let title, message, isSuccess = false;
  try {
    if (action === 'confirm_sk_owner_all') {
      const r = confirmSkOwnershipAll(suiteKey);
      title   = 'Ownership Confirmed';
      message = 'Thank you! You have been added as the owner of SuiteKey ' + suiteKey +
                ' and ' + r.advanced + ' pending request' + (r.advanced === 1 ? ' is' : 's are') +
                ' now awaiting your approval — check your email.';
    } else {
      const r = denySkOwnershipAll(suiteKey);
      title   = 'Ownership Denied';
      message = 'Thank you for responding. ' + r.declined + ' requestor' +
                (r.declined === 1 ? ' has' : 's have') + ' been notified that the SuiteKey owner could not be confirmed.';
    }
    isSuccess = true;
  } catch (ex) {
    title   = 'Action Failed';
    message = ex.message;
  }
  const color = isSuccess ? '#137333' : '#c5221f';
  const icon  = isSuccess ? '&#10003;' : '&#10007;';
  return HtmlService.createHtmlOutput(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${title}</title>
<style>body{font-family:'Google Sans',Arial,sans-serif;max-width:480px;margin:80px auto;
text-align:center;color:#202124;padding:0 16px}
h2{color:${color}}p{color:#5f6368;font-size:14px;line-height:1.7}a{color:#1a73e8}</style>
</head><body>
<h2>${icon} ${title}</h2><p>${message}</p>
<p><a href="${getWebAppUrl()}">Return to License Manager</a></p>
</body></html>`)
    .setTitle(title)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function _handleApprovalLink(action, subId) {
  let title, message, isSuccess = false;
  try {
    if (action === 'approve') {
      approveSubscription(subId);
      title   = 'Request Approved';
      message = 'The subscription has been approved and the subscriber has been notified.';
    } else {
      declineSubscription(subId);
      title   = 'Request Declined';
      message = 'The request has been declined and the subscriber has been notified.';
    }
    isSuccess = true;
  } catch (ex) {
    title   = 'Action Failed';
    message = ex.message;
  }
  const color = isSuccess ? '#137333' : '#c5221f';
  const icon  = isSuccess ? '✓' : '✗';
  return HtmlService.createHtmlOutput(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${title}</title>
<style>body{font-family:'Google Sans',Arial,sans-serif;max-width:480px;margin:80px auto;
text-align:center;color:#202124;padding:0 16px}
h2{color:${color}}p{color:#5f6368;font-size:14px;line-height:1.7}a{color:#1a73e8}</style>
</head><body>
<h2>${icon} ${title}</h2><p>${message}</p>
<p><a href="${getWebAppUrl()}">Return to License Manager</a></p>
</body></html>`)
    .setTitle(title)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


// ============================================================
//  INITIAL LOAD
// ============================================================

/**
 * Single batched call on first load. Returns everything the
 * client needs to render the correct tabs for this user.
 */
function getInitialData() {
  const t0 = Date.now();
  try {
    const email      = getCurrentUserEmail();
    const configured = isAppConfigured();

    if (!configured) {
      return {
        userEmail  : email,
        needsSetup : true,
        currentFY  : getCurrentFiscalYear(),
        ms         : Date.now() - t0,
      };
    }

    const adminFlag = isLicenseManager(email);
    const ownedKeys = getSuiteKeyOwnerKeys(email);
    const mgrFlag   = isOrgManager(email);

    return {
      userEmail       : email,
      needsSetup      : false,
      isAdmin         : adminFlag,
      isSuiteKeyOwner : ownedKeys.length > 0,
      ownedSuiteKeys  : ownedKeys,
      isManager         : mgrFlag,
      isServiceManager  : isServiceManagerForAny(email),
      currentFY         : getCurrentFiscalYear(),
      licenses        : getActiveLicenses(),
      mySubs          : getMySubscriptions(),
      ministryId      : getMyMinistryId(),
      ms              : Date.now() - t0,
    };
  } catch (e) {
    console.error('getInitialData error: ' + e.message);
    return {
      userEmail       : '',
      isAdmin         : false,
      isSuiteKeyOwner : false,
      ownedSuiteKeys  : [],
      isManager        : false,
      isServiceManager : false,
      currentFY        : getCurrentFiscalYear(),
      licenses         : [],
      mySubs           : [],
      error            : e.message,
    };
  }
}


// ============================================================
//  AUTH & ROLE HELPERS
// ============================================================

/**
 * Returns the email of the user who opened the web app.
 * Works correctly when deployed as Execute as = Me, because
 * getActiveUser() returns the accessing user, not the owner.
 */
function getCurrentUserEmail() {
  try {
    const email = Session.getActiveUser().getEmail();
    if (email) return email.toLowerCase();
  } catch (e) {}
  return '';
}

/**
 * Returns true if email is in the license_manager_emails setting.
 */
function isLicenseManager(email) {
  if (!email) return false;
  const val = getSettingValue('license_manager_emails');
  if (!val) return false;
  return val.split(',').map(e => e.trim().toLowerCase()).includes(email.toLowerCase());
}

/**
 * Throws if the current user is not a License Manager.
 * Call at the top of every admin function.
 */
function requireLicenseManager() {
  if (!isLicenseManager(getCurrentUserEmail())) {
    throw new Error('Access denied: License Manager role required.');
  }
}

/**
 * Returns all SuiteKeys where this email is the Owner in
 * the permissions sheet.
 */
function getSuiteKeyOwnerKeys(email) {
  const perm = getPermissionsData();
  if (!perm.data) return [];
  const lower = email.toLowerCase();
  const keys  = [];
  for (let i = 1; i < perm.data.length; i++) {
    const row   = perm.data[i];
    const sk    = String(row[0] || '').trim();
    const owner = String(row[2] || '').trim().toLowerCase();
    if (sk && owner === lower) keys.push(sk);
  }
  return keys;
}

/**
 * Returns true if this email appears as a ManagerEmail in the
 * hierarchy sheet (i.e., at least one person reports to them).
 */
function isOrgManager(email) {
  if (!email) return false;
  const cache  = CacheService.getScriptCache();
  const ckey   = 'mgr:' + email.toLowerCase();
  const cached = cache.get(ckey);
  if (cached !== null) return cached === '1';
  const hier  = getHierarchyData();
  const lower = email.toLowerCase();
  let   found = false;
  if (hier) {
    for (let i = 1; i < hier.length; i++) {
      if (String(hier[i][1] || '').trim().toLowerCase() === lower) { found = true; break; }
    }
  }
  try { cache.put(ckey, found ? '1' : '0', 3600); } catch (e) {}
  return found;
}


function isServiceManagerForAny(email) {
  if (!email) return false;
  const sheet = getTab(TAB_LICENSES);
  if (!sheet) return false;
  const rows  = sheet.getDataRange().getValues();
  const lower = email.toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    const active = rows[i][7] === true || String(rows[i][7]).toLowerCase() === 'true';
    if (!active) continue;
    if (String(rows[i][19] || '').trim().toLowerCase() === lower) return true;
  }
  return false;
}

// ============================================================
//  DATA ACCESS — EXTERNAL SHEETS
// ============================================================

/**
 * Returns raw permissions sheet data from cache (ScriptProperties)
 * or falls back to a direct read. Uses the same format as Budget Tracker.
 * Result is cached for the duration of the execution.
 */
function getPermissionsData() {
  if (_permData !== undefined) return _permData;
  const sp     = PropertiesService.getScriptProperties();
  const cached = sp.getProperty(SPROP_PERMISSIONS_CACHE);
  if (cached) {
    try {
      _permData = { data: JSON.parse(cached), fromCache: true };
      return _permData;
    } catch (e) {}
  }
  const permId = sp.getProperty(SPROP_PERMISSIONS_ID);
  if (!permId) {
    _permData = { data: null, error: 'no_permissions_sheet' };
    return _permData;
  }
  try {
    const ss    = SpreadsheetApp.openById(permId);
    const sheet = ss.getSheetByName(PERM_TAB_SUITEKEYS) || ss.getSheets()[0];
    const data  = sheet.getDataRange().getValues();
    _permData = { data, fromCache: false };
    return _permData;
  } catch (e) {
    _permData = { data: null, error: 'cannot_open_permissions: ' + e.message };
    return _permData;
  }
}

/**
 * Returns raw Ministry IDs sheet data, using a ScriptProperties cache.
 */
function getMinistryData() {
  if (_ministryData !== undefined) return _ministryData;
  const sp     = PropertiesService.getScriptProperties();
  const cached = sp.getProperty(SPROP_MINISTRY_IDS_CACHE);
  if (cached) {
    try {
      _ministryData = JSON.parse(cached);
      return _ministryData;
    } catch (e) {}
  }
  const permId = sp.getProperty(SPROP_PERMISSIONS_ID);
  if (!permId) { _ministryData = null; return null; }
  try {
    const sheet = SpreadsheetApp.openById(permId).getSheetByName(PERM_TAB_MINISTRY_IDS);
    if (!sheet) { _ministryData = null; return null; }
    _ministryData = sheet.getDataRange().getValues();
    return _ministryData;
  } catch (e) {
    _ministryData = null;
    return null;
  }
}

/**
 * Reads and caches the permissions sheet into ScriptProperties
 * so end users never need direct sheet access. Admins run this
 * after any change to the permissions sheet.
 */
function syncPermissionsCache() {
  requireLicenseManager();
  const sp     = PropertiesService.getScriptProperties();
  const permId = sp.getProperty(SPROP_PERMISSIONS_ID);
  if (!permId) return { ok: false, error: 'No permissions sheet ID configured.' };
  try {
    const ss      = SpreadsheetApp.openById(permId);
    const skSheet = ss.getSheetByName(PERM_TAB_SUITEKEYS) || ss.getSheets()[0];
    const skData  = skSheet.getDataRange().getValues();
    sp.setProperty(SPROP_PERMISSIONS_CACHE, JSON.stringify(skData));

    const minSheet = ss.getSheetByName(PERM_TAB_MINISTRY_IDS);
    if (minSheet) {
      sp.setProperty(SPROP_MINISTRY_IDS_CACHE, JSON.stringify(minSheet.getDataRange().getValues()));
    }

    // Clear the isOrgManager CacheService entries for everyone in the hierarchy
    const hierId = sp.getProperty(SPROP_HIERARCHY_ID);
    if (hierId) {
      try {
        const hierData = SpreadsheetApp.openById(hierId).getSheets()[0].getDataRange().getValues();
        const cache    = CacheService.getScriptCache();
        const keys     = [];
        for (let i = 1; i < hierData.length; i++) {
          const email = String(hierData[i][0] || '').trim().toLowerCase();
          if (email) keys.push('mgr:' + email);
        }
        if (keys.length) cache.removeAll(keys);
      } catch (e) {}
    }

    return { ok: true, rows: Math.max(0, skData.length - 1) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Returns raw staff hierarchy sheet data (2D array).
 * The hierarchy sheet is accessible ONLY to the script owner —
 * it is never readable directly by org members.
 * Result is cached for the duration of the execution.
 */
function getHierarchyData() {
  if (_hierarchyData !== undefined) return _hierarchyData;
  const sp      = PropertiesService.getScriptProperties();
  const hierId  = sp.getProperty(SPROP_HIERARCHY_ID);
  if (!hierId) { _hierarchyData = null; return null; }
  try {
    _hierarchyData = SpreadsheetApp.openById(hierId).getSheets()[0].getDataRange().getValues();
    return _hierarchyData;
  } catch (e) {
    console.error('getHierarchyData error: ' + e.message);
    _hierarchyData = null;
    return null;
  }
}


// ============================================================
//  DATA ACCESS — APP SPREADSHEET
// ============================================================

function getAppSpreadsheet() {
  if (_appSS) return _appSS;
  const id = PropertiesService.getScriptProperties().getProperty(SPROP_APP_SHEET_ID);
  if (!id) return null;
  _appSS = SpreadsheetApp.openById(id);
  return _appSS;
}

function getTab(name) {
  const ss = getAppSpreadsheet();
  if (!ss) return null;
  return ss.getSheetByName(name);
}

function isAppConfigured() {
  return !!PropertiesService.getScriptProperties().getProperty(SPROP_APP_SHEET_ID);
}


// ============================================================
//  SETTINGS (key/value tab)
// ============================================================

function getSettingValue(key) {
  try {
    const sheet = getTab(TAB_SETTINGS);
    if (!sheet) return '';
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).trim() === key) return String(rows[i][1] || '');
    }
    return '';
  } catch (e) {
    return '';
  }
}

function setSettingValue(key, value) {
  const sheet = getTab(TAB_SETTINGS);
  if (!sheet) throw new Error('Settings tab not found.');
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function getAdminSettings() {
  requireLicenseManager();
  const sp = PropertiesService.getScriptProperties();
  return {
    appSheetId           : sp.getProperty(SPROP_APP_SHEET_ID)   || '',
    permissionsSheetId   : sp.getProperty(SPROP_PERMISSIONS_ID) || '',
    hierarchySheetId     : sp.getProperty(SPROP_HIERARCHY_ID)   || '',
    licenseManagerEmails : getSettingValue('license_manager_emails'),
    renewalEmailsSentFy  : getSettingValue('renewal_emails_sent_fy'),
  };
}

function saveAdminSettings(settings) {
  requireLicenseManager();
  const sp = PropertiesService.getScriptProperties();
  if (settings.permissionsSheetId != null) {
    const id = parseSheetId(String(settings.permissionsSheetId));
    if (id) {
      try { SpreadsheetApp.openById(id); } catch (e) {
        return { ok: false, error: 'Cannot open permissions sheet: ' + e.message };
      }
      sp.setProperty(SPROP_PERMISSIONS_ID, id);
    }
  }
  if (settings.hierarchySheetId != null) {
    const id = parseSheetId(String(settings.hierarchySheetId));
    if (id) {
      try { SpreadsheetApp.openById(id); } catch (e) {
        return { ok: false, error: 'Cannot open hierarchy sheet: ' + e.message };
      }
      sp.setProperty(SPROP_HIERARCHY_ID, id);
    }
  }
  if (settings.licenseManagerEmails != null) {
    setSettingValue('license_manager_emails', String(settings.licenseManagerEmails).trim());
  }
  return { ok: true };
}


// ============================================================
//  FISCAL YEAR
// ============================================================

function getCurrentFiscalYear() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  return month >= FISCAL_YEAR_START_MONTH ? year + 1 : year;
}


// ============================================================
//  UTILITIES
// ============================================================

function generateId(prefix) {
  return prefix + '-' + Math.random().toString(36).substr(2, 8).toUpperCase();
}

function parseSheetId(input) {
  input = String(input || '').trim();
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : input;
}


// ============================================================
//  ONE-TIME SETUP
// ============================================================

/**
 * Creates the app spreadsheet with all required tabs.
 * Run once from the Apps Script editor after deploying.
 * The script must NOT already have an APP_SHEET_ID configured.
 */
function initializeAppSheet(adminEmail) {
  const sp       = PropertiesService.getScriptProperties();
  const existing = sp.getProperty(SPROP_APP_SHEET_ID);
  if (existing) {
    requireLicenseManager();
    return { ok: false, error: 'Already initialized. Sheet ID: ' + existing };
  }
  // First-time setup — no license manager exists yet, so anyone can run this once.

  const ss = SpreadsheetApp.create('License Manager Data');

  // Licenses tab
  const licSheet = ss.getActiveSheet().setName(TAB_LICENSES);
  licSheet.appendRow(['ID', 'Name', 'Vendor', 'Category', 'Price', 'PriceUnit', 'Notes', 'Active', 'GtisSponsored', 'BillingCycle', 'RenewalMonth', 'RenewalReminder', 'CreatedBy', 'LogoUrl', 'ActivationUrl', 'Activated', 'MoreInfoUrl', 'GoogleGroupEmail', 'ProRated']);
  licSheet.getRange(1, 1, 1, 19).setFontWeight('bold').setBackground('#e8f0fe');

  // Subscriptions tab
  const subSheet = ss.insertSheet(TAB_SUBSCRIPTIONS);
  subSheet.appendRow(['ID', 'UserEmail', 'LicenseName', 'LicenseID', 'SuiteKey', 'StartDate', 'FY', 'Status', 'RenewalStatus', 'BillingCycle', 'RenewalMonth', 'RenewalReminder', 'PendingApproverEmail']);
  subSheet.getRange(1, 1, 1, 13).setFontWeight('bold').setBackground('#e8f0fe');

  // Renewals tab
  const renSheet = ss.insertSheet(TAB_RENEWALS);
  renSheet.appendRow(['ID', 'SubscriptionID', 'FiscalYear', 'OptInDate', 'OptedInBy']);
  renSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#e8f0fe');

  // Audit Log tab
  const audSheet = ss.insertSheet(TAB_AUDIT);
  audSheet.appendRow(['ID', 'Timestamp', 'Action', 'SubscriptionID', 'LicenseName', 'UserEmail', 'SuiteKey', 'PerformedBy', 'Notes']);
  audSheet.getRange(1, 1, 1, 9).setFontWeight('bold').setBackground('#e8f0fe');

  // Settings tab
  const setSheet   = ss.insertSheet(TAB_SETTINGS);
  const firstAdmin = adminEmail || getCurrentUserEmail();
  setSheet.appendRow(['Key', 'Value']);
  setSheet.appendRow(['license_manager_emails', firstAdmin]);
  setSheet.appendRow(['renewal_emails_sent_fy', '']);
  setSheet.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#e8f0fe');

  sp.setProperty(SPROP_APP_SHEET_ID, ss.getId());
  return { ok: true, sheetId: ss.getId(), sheetUrl: ss.getUrl(), adminEmail: firstAdmin };
}
