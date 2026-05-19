/**
 * Extract availability from RMS Cloud Booking Chart.
 * Rules:
 *  - Base: unit "available" on D = free on D AND no reservation in [D, D+30 days)
 *  - Sept (9.1-9.30) extra: last reservation end before D must be >= 2026-08-01
 *    (rooms empty since July or earlier are excluded; only fresh Aug-checkout rooms shown)
 *  - 2BR sets: if scheduler DOM is available, parse unit names like "08.14.1" /
 *    "08.14.2" and detect when both beds in same room are free → count as 1 set
 *
 * HOW TO RUN: paste into RMS Cloud Booking Chart DevTools Console.
 * Configured for Y Suites on Margaret (Property ID 9).
 */
(async () => {
  const PROPERTY_ID = 9, DAYS_AHEAD = 180, LOOKAHEAD_DAYS = 30;
  // Sept filter: room is eligible for Sep if its last checkout is >= Aug 1
  // (> 2026-07-31 is equivalent to >= 2026-08-01)
  const FRESH_VACATE_CUTOFF = new Date('2026-07-31T23:59:59').getTime();
  const SEPT_START = new Date('2026-09-01T00:00:00').getTime();
  const SEPT_END = new Date('2026-09-30T23:59:59').getTime();
  const TODAY = new Date(); TODAY.setHours(0,0,0,0);

  const simplify = (name) => {
    let s = name.replace(/\s*YSMG\s*$/i, '').trim();
    return s.replace(/\s*\(High Floor\)/i, '-High').replace(/\s*\(Low Floor\)/i, '-Low').trim();
  };

  const opts = await fetch('/api/BookingChart/InitializeOptions', {credentials: 'include'}).then(r => r.json());
  const myCats = opts.Categories.filter(c => c.PropertyId === PROPERTY_ID && !c.Inactive);
  const catMap = {};
  myCats.forEach(c => { catMap[c.CatId] = simplify(c.CategoryName); });
  const myCatIds = new Set(Object.keys(catMap).map(Number));

  const fromStr = encodeURIComponent(`${TODAY.getDate()}/${TODAY.getMonth()+1}/${TODAY.getFullYear()}`);
  const end = new Date(TODAY); end.setDate(end.getDate() + DAYS_AHEAD);
  const toStr = encodeURIComponent(`${end.getDate()}/${end.getMonth()+1}/${end.getFullYear()}`);
  const resp = await fetch(`/api/BookingChart/RefreshResDataOnlyAsync?from=${fromStr}&includeSpecialEvents=false&lastModifiedDate=1%2F1%2F2020+00:00:00.0&state=onehundredEightyDays&to=${toStr}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}', credentials: 'include'
  }).then(r => r.json());

  const ACTIVE = resp.Reservations.filter(r => myCatIds.has(r.OriginalCatId) && r.ResStatus !== 'Cancelled' && r.ResStatus !== 'Quote' && !r.IsEvent)
    .map(r => ({catId: r.OriginalCatId, areaId: r.OriginalAreaId, s: new Date(r.start_date).getTime(), e: new Date(r.end_date).getTime()}));

  const unitRes = {};
  for (const r of ACTIVE) { (unitRes[r.areaId] = unitRes[r.areaId] || []).push(r); }

  const areasByCat = {}; for (const cid of myCatIds) areasByCat[cid] = new Set();
  resp.Reservations.forEach(r => { if (myCatIds.has(r.OriginalCatId)) areasByCat[r.OriginalCatId].add(r.OriginalAreaId); });
  const totals = {}; for (const cid of myCatIds) totals[cid] = areasByCat[cid].size;

  // Build areaId → unitName map. Try multiple sources so set-detection works even
  // when the Booking Chart DOM isn't rendered (headless / fresh tab).
  const areaIdToUnitName = {};
  // (a) DOM (works when Booking Chart is visible)
  document.querySelectorAll('[data-section-id]').forEach(el => {
    const sid = parseInt(el.getAttribute('data-section-id'), 10);
    if (isNaN(sid)) return;
    const txt = (el.innerText || el.textContent || '').trim();
    const m = txt.match(/^([\d.]+)\s/);
    if (m) areaIdToUnitName[sid] = m[1];
  });
  // (b) InitializeOptions Areas list
  const areaSrc = (opts.Areas || opts.AreaList || opts.areas || []).filter(a =>
    a && (a.PropertyId === undefined || a.PropertyId === PROPERTY_ID));
  for (const a of areaSrc) {
    const id = a.AreaId ?? a.Id ?? a.areaId;
    const name = a.AreaName ?? a.Name ?? a.areaName ?? a.AreaCode;
    if (id != null && name && !areaIdToUnitName[id]) areaIdToUnitName[id] = String(name).trim();
  }
  // (c) Reservation payload fields
  for (const r of resp.Reservations) {
    if (!myCatIds.has(r.OriginalCatId)) continue;
    const id = r.OriginalAreaId;
    if (id == null || areaIdToUnitName[id]) continue;
    const n = r.AreaName ?? r.AreaCode ?? r.area_name ?? r.areaName;
    if (n) areaIdToUnitName[id] = String(n).trim();
  }

  // For 2BR categories, group areas by "AA.BB" room prefix
  const TWO_BR_CATS = new Set();
  for (const cid of myCatIds) if (catMap[cid].startsWith('2BR')) TWO_BR_CATS.add(cid);

  const roomPairs = {};  // catId → {roomKey: [areaId1, areaId2]}
  for (const cid of TWO_BR_CATS) {
    roomPairs[cid] = {};
    for (const aid of areasByCat[cid]) {
      const name = areaIdToUnitName[aid];
      if (!name) continue;
      const parts = name.split('.');
      if (parts.length < 3) continue;
      const roomKey = parts.slice(0, -1).join('.');
      (roomPairs[cid][roomKey] = roomPairs[cid][roomKey] || []).push(aid);
    }
  }
  const hasUnitNames = Object.keys(areaIdToUnitName).length > 0;

  function isFreshlyVacatedBy(areaId, dateMs) {
    const list = unitRes[areaId] || [];
    let latestEndBefore = null;
    for (const r of list) {
      if (r.e <= dateMs && (latestEndBefore === null || r.e > latestEndBefore)) latestEndBefore = r.e;
    }
    return latestEndBefore !== null && latestEndBefore > FRESH_VACATE_CUTOFF;
  }

  function isAreaFree(areaId, winStart, winEnd) {
    for (const r of (unitRes[areaId] || [])) {
      if (r.s < winEnd && r.e > winStart) return false;
    }
    return true;
  }

  const avail = {}, setsAvail = {};
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(TODAY); d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0,10);
    const winStart = d.getTime(), winEnd = winStart + LOOKAHEAD_DAYS * 86400000;
    const isSept = winStart >= SEPT_START && winStart <= SEPT_END;
    const cats = {};
    const sets = {};
    for (const cid of myCatIds) {
      let count = 0;
      for (const aid of areasByCat[cid]) {
        if (!isAreaFree(aid, winStart, winEnd)) continue;
        if (isSept && !isFreshlyVacatedBy(aid, winStart)) continue;
        count++;
      }
      cats[catMap[cid]] = count;
      // For 2BR, additionally compute sets (both .1 and .2 free)
      if (TWO_BR_CATS.has(cid) && hasUnitNames) {
        let setCount = 0;
        for (const roomKey in roomPairs[cid]) {
          const aids = roomPairs[cid][roomKey];
          if (aids.length < 2) continue;
          const allFree = aids.every(aid =>
            isAreaFree(aid, winStart, winEnd) &&
            (!isSept || isFreshlyVacatedBy(aid, winStart))
          );
          if (allFree) setCount++;
        }
        sets[catMap[cid]] = setCount;
      }
    }
    avail[ds] = cats;
    if (Object.keys(sets).length) setsAvail[ds] = sets;
  }

  const result = {
    lastUpdated: new Date().toISOString(),
    propertyName: 'Y Suites on Margaret',
    propertyCode: 'YSMG',
    availabilityRule: '30day-continuous + Sep-only-recently-vacated (cutoff Aug 1 = vacated Aug or later)' + (hasUnitNames ? ' + 2BR-sets' : ''),
    categoryDisplayNames: {
      "SP-High": "Studio Premium (高楼层)", "SP-Low": "Studio Premium (低楼层)",
      "SD-High": "Studio Deluxe (高楼层)", "SD-Low": "Studio Deluxe (低楼层)",
      "ENP": "Ensuite Premium",
      "2BR-High": "2 Bedroom Apartment (高楼层)", "2BR-Low": "2 Bedroom Apartment (低楼层)"
    },
    totalsByCategory: Object.fromEntries(Object.entries(catMap).map(([cid, code]) => [code, totals[cid]])),
    availability: avail
  };
  if (hasUnitNames) result.setsByDate = setsAvail;

  window.__availJson = JSON.stringify(result);
  console.log('=== AVAILABILITY JSON ===');
  console.log(window.__availJson);
  console.log('=== END ===');
  console.log(`✓ ${Object.keys(avail).length} days, ${ACTIVE.length} active res, unit names: ${hasUnitNames ? 'YES (2BR sets computed)' : 'NO (no DOM data, sets skipped)'}`);
  return result;
})();
