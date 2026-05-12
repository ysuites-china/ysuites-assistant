/**
 * Extract availability data from RMS Cloud Booking Chart.
 *
 * AVAILABILITY RULE: A unit counts as "available" on date D only if it is
 * free on D AND has no reservation overlapping the next 30 days.
 *
 * HOW TO RUN:
 *   1. Open https://app12.rmscloud.com/ and log in
 *   2. (Optional) navigate to Booking Chart so session is warm
 *   3. Open DevTools Console (F12), paste this entire script
 *   4. The script will fetch data and stash JSON on window.__availJson
 *
 * Configured for: Y Suites on Margaret (Property ID 9)
 */
(async () => {
  const PROPERTY_ID = 9;
  const PROPERTY_CODE = 'YSMG';
  const PROPERTY_NAME = 'Y Suites on Margaret';
  const DAYS_AHEAD = 180;
  const LOOKAHEAD_DAYS = 30; // 30-day continuous availability rule
  const TODAY = new Date(); TODAY.setHours(0,0,0,0);

  const simplify = (name) => {
    let s = name.replace(/\s*YSMG\s*$/i, '').trim();
    s = s.replace(/\s*\(High Floor\)/i, '-High').replace(/\s*\(Low Floor\)/i, '-Low');
    return s.trim();
  };

  // 1. Categories
  const opts = await fetch('/api/BookingChart/InitializeOptions', {credentials: 'include'}).then(r => r.json());
  const myCats = opts.Categories.filter(c => c.PropertyId === PROPERTY_ID && !c.Inactive);
  const catMap = {};
  myCats.forEach(c => { catMap[c.CatId] = simplify(c.CategoryName); });
  const myCatIds = new Set(Object.keys(catMap).map(Number));

  // 2. All reservations (use lastModifiedDate=2020 to get full dataset, not delta)
  const fromStr = encodeURIComponent(`${TODAY.getDate()}/${TODAY.getMonth()+1}/${TODAY.getFullYear()}`);
  const end = new Date(TODAY); end.setDate(end.getDate() + DAYS_AHEAD);
  const toStr = encodeURIComponent(`${end.getDate()}/${end.getMonth()+1}/${end.getFullYear()}`);
  const resp = await fetch(`/api/BookingChart/RefreshResDataOnlyAsync?from=${fromStr}&includeSpecialEvents=false&lastModifiedDate=1%2F1%2F2020+00:00:00.0&state=onehundredEightyDays&to=${toStr}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}', credentials: 'include'
  }).then(r => r.json());

  // 3. Active reservations (this property, non-cancelled)
  const ACTIVE = resp.Reservations.filter(r => myCatIds.has(r.OriginalCatId) && r.ResStatus !== 'Cancelled' && r.ResStatus !== 'Quote' && !r.IsEvent)
    .map(r => ({catId: r.OriginalCatId, areaId: r.OriginalAreaId, s: new Date(r.start_date).getTime(), e: new Date(r.end_date).getTime()}));

  // 4. Total units per category (from all areas ever seen)
  const areasByCat = {}; for (const cid of myCatIds) areasByCat[cid] = new Set();
  resp.Reservations.forEach(r => { if (myCatIds.has(r.OriginalCatId)) areasByCat[r.OriginalCatId].add(r.OriginalAreaId); });
  const totals = {}; for (const cid of myCatIds) totals[cid] = areasByCat[cid].size;

  // 5. For each (date, category), count areas with NO reservation overlap in [date, date+30days)
  const avail = {};
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(TODAY); d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0,10);
    const winStart = d.getTime();
    const winEnd = winStart + LOOKAHEAD_DAYS * 86400000;
    const cats = {};
    for (const cid of myCatIds) {
      const occupied = new Set();
      for (const r of ACTIVE) {
        if (r.catId !== cid) continue;
        if (r.s < winEnd && r.e > winStart) occupied.add(r.areaId);
      }
      cats[catMap[cid]] = totals[cid] - occupied.size;
    }
    avail[ds] = cats;
  }

  const result = {
    lastUpdated: new Date().toISOString(),
    propertyName: PROPERTY_NAME,
    propertyCode: PROPERTY_CODE,
    availabilityRule: '30day-continuous',
    availabilityNote: '剩余数 = 在该日期当天空出，且未来30天内连续无其他订单占位的单元数',
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
  console.log(`✓ Extracted ${Object.keys(avail).length} days, ${ACTIVE.length} active reservations (30-day rule)`);
  return result;
})();
