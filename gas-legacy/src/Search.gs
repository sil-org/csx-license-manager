// ============================================================
//  SEARCH — SuiteKey typeahead and license search
// ============================================================

/**
 * Returns up to 10 SuiteKeys that start with the given query,
 * filtered to only those the current user is authorized for
 * (owner or viewer in the permissions sheet).
 *
 * Requires query.length >= 2 to prevent returning too many results.
 */
function searchSuiteKeys(query) {
  query = String(query || '').trim().toLowerCase();
  if (query.length < 2) return [];

  const email = getCurrentUserEmail();
  const perm  = getPermissionsData();
  if (!perm.data) return [];

  const results = [];
  for (let i = 1; i < perm.data.length; i++) {
    const row         = perm.data[i];
    const sk          = String(row[0] || '').trim();
    const owner       = String(row[2] || '').trim().toLowerCase();
    const description = String(row[4] || '').trim();
    if (!sk) continue;
    const lsk  = sk.toLowerCase();
    const ldesc = description.toLowerCase();
    if (!lsk.startsWith(query) && !ldesc.includes(query)) continue;

    const isOwner  = owner === email;
    const hasOwner = !!owner;
    results.push({ suiteKey: sk, isOwner, hasOwner, description });
    if (results.length >= 10) break;
  }
  return results;
}

/**
 * Returns all active licenses from the catalog.
 * Used to populate the Browse tab on load.
 */
function getActiveLicenses() {
  const sheet = getTab(TAB_LICENSES);
  if (!sheet) return [];
  const rows     = sheet.getDataRange().getValues();
  const licenses = [];
  for (let i = 1; i < rows.length; i++) {
    const r      = rows[i];
    const active = r[7] === true || String(r[7]).toLowerCase() === 'true';
    if (!active) continue;
    licenses.push({
      id             : String(r[0]),
      name           : String(r[1]),
      vendor         : String(r[2]),
      category       : String(r[3]),
      price          : Number(r[4]) || 0,
      priceUnit      : String(r[5]),
      notes          : String(r[6]),
      gtisSponsored  : r[8] === true || String(r[8] || '').toLowerCase() === 'true',
      billingCycle   : String(r[9] || 'annual').toLowerCase(),
      renewalMonth   : Number(r[10]) || 0,
      renewalReminder: r[11] === true || String(r[11] || '').toLowerCase() === 'true',
      createdBy      : String(r[12] || ''),
      logoUrl        : String(r[13] || ''),
      moreInfoUrl      : String(r[16] || ''),
      googleGroupEmail : String(r[17] || ''),
      proRated         : r[18] === true || String(r[18] || '').toLowerCase() === 'true',
      serviceManager   : String(r[19] || '').trim().toLowerCase(),
    });
  }
  return licenses;
}

/**
 * Filters active licenses by name, vendor, or category.
 * Empty query returns all active licenses.
 */
function searchLicenses(query) {
  query = String(query || '').trim().toLowerCase();
  const all = getActiveLicenses();
  if (!query) return all;
  return all.filter(l =>
    l.name.toLowerCase().includes(query) ||
    l.vendor.toLowerCase().includes(query) ||
    l.category.toLowerCase().includes(query)
  );
}
