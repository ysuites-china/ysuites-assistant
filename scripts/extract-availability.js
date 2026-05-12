/**
 * Extract availability data from RMS Cloud Booking Chart.
 * 
 * HOW TO RUN:
 *   1. Open https://app12.rmscloud.com/ and log in
 *   2. Click Charts → Booking Chart
 *   3. Open DevTools Console (F12), paste this entire script
 *   4. The script will fetch data and copy the JSON to clipboard / log it
 *
 * Configured for: Y Suites on Margaret (Property ID 9)
 */
(async () => {
  const PROPERTY_ID = 9;
  const PROPERTY_CODE = 'YSMG';
  const PROPERTY_NAME = 'Y Suites on Margaret';
  const DAYS_AHEAD = 180;
  const TODAY = new Date(); TODAY.setHours(0,0,0,0);

  // Category name simplifier
  const simplify = (name) => {
    let s = name.replace(/\s*YSMG\s*$/i, '').trim();
    s = s.replace(/\s*\(High Floor\)/i, '-High').replace(/\s*\(Low Floor\)/i, '-Low');
    return s.trim();
  };

  // 1. Get categories
  const opts = await fetch('/api/BookingChart/InitializeOptions', {credentials: 'include'}).then(r => r.json());
  const myCats = opts.Categories.filter(c => c.PropertyId === PROPERTY_ID && !c.Inactive);
  const catMap = {};
  myCats.forEach(c => { catMap[c.CatId] = simplify(c.CategoryName); });
  const myCatIds = new Set(Object.keys(catMap).map(Number));

  // 2. Get all reservations (use far-past lastModifiedDate to get everything, not just delta)
  const fromStr = encodeURIComponent(`${TODAY.getDate()}/${TODAY.getMonth()+1}/${TODAY.getFullYear()}`);
  const end = new Date(TODAY); end.setDate(end.getDate() + DAYS_AHEAD);
  const toStr = encodeURIComponent(`${end.getDate()}/${end.getMonth()+1}/${end.getFullYear()}`);
  const resp = await fetch(`/api/BookingChart/RefreshResDataOnlyAsync?from=${fromStr}&includeSpecialEvents=false&lastModifiedDate=1%2F1%2F2020+00:00:00.0&state=onehundredEightyDays&to=${toStr}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}', credentials: 'include'
  }).then(r => r.json());

  // 3. Filter to active reservations for this property
  const ACTIVE = resp.Reservations.filter(r =>
    myCatIds.has(r.OriginalCatId) &&
    r.ResStatus !== 'Cancelled' &&
    r.ResStatus !== 'Quote' &&
    !r.IsEvent
  );

  // 4. Total units per category (from all area IDs ever seen)
  const totalsSet = {};
  for (const cid of myCatIds) totalsSet[cid] = new Set();
  resp.Reservations.forEach(r => {
    if (myCatIds.has(r.OriginalCatId)) totalsSet[r.OriginalCatId].add(r.OriginalAreaId);
  });
  const totals = {}; for (const cid of myCatIds) totals[cid] = totalsSet[cid].size;

  // 5. Per-day availability
  const avail = {};
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(TODAY); d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0,10);
    const ds_ms = d.getTime(); const de_ms = ds_ms + 86400000;
    const cats = {};
    for (const cid of myCatIds) {
      const occ = new Set();
      for (const r of ACTIVE) {
        if (r.OriginalCatId !== cid) continue;
        if (new Date(r.start_date).getTime() < de_ms && new Date(r.end_date).getTime() > ds_ms) {
          occ.add(r.OriginalAreaId);
        }
      }
      cats[catMap[cid]] = totals[cid] - occ.size;
    }
    avail[ds] = cats;
  }

  const result = {
    lastUpdated: new Date().toISOString(),
    propertyName: PROPERTY_NAME,
    propertyCode: PROPERTY_CODE,
    categoryDisplayNames: {
      "SP-High": "Studio Premium (高楼层)",
      "SP-Low": "Studio Premium (低楼层)",
      "SD-High": "Studio Deluxe (高楼层)",
      "SD-Low": "Studio Deluxe (低楼层)",
      "ENP": "Ensuite Premium",
      "2BR-High": "2 Bedroom Apartment (高楼层)",
      "2BR-Low": "2 Bedroom Apartment (低楼层)"
    },
    totalsByCategory: Object.fromEntries(Object.entries(catMap).map(([cid, code]) => [code, totals[cid]])),
    availability: avail
  };

  window.__availJson = JSON.stringify(result);
  console.log('=== AVAILABILITY JSON ===');
  console.log(window.__availJson);
  console.log('=== END ===');
  console.log(`✓ Extracted ${Object.keys(avail).length} days, ${ACTIVE.length} active reservations`);

  // Try to copy to clipboard (may need user interaction)
  try {
    await navigator.clipboard.writeText(window.__availJson);
    console.log('✓ Copied to clipboard');
  } catch(e) {
    console.log('Clipboard copy failed, but JSON is in window.__availJson');
  }
  return result;
})();
