// =====================================================================
// Find Optimal Running Window
// =====================================================================
// n8n Code node — drop this into your Code node body.
// Reads from upstream Fetch Runna Events, Fetch General Calendar, and
// Fetch Weather Forecast nodes. Outputs one item per scheduled run with
// the optimal window, alternate window, and score breakdown.
// =====================================================================

const runnaRaw   = $('Fetch Runna Events').all().map(i => i.json);
const generalRaw = $('Fetch General Calendar').all().map(i => i.json);
const weatherRaw = $('Fetch Weather Forecast').all().map(i => i.json);

// =====================================================================
// MODE DETECTION — based on which trigger fired (works for manual exec too)
// =====================================================================
const TZ = 'America/Montreal';

function triggerFired(name) {
  try {
    const items = $(name).all();
    return Array.isArray(items) && items.length > 0;
  } catch (e) {
    return false;
  }
}

let mode;
if (triggerFired('Weekly trigger')) {
  mode = 'weekly';
} else if (triggerFired('Daily at 8:00 AM')) {
  mode = 'daily';
} else {
  // Fallback: clock-based detection
  const localDay  = new Date().toLocaleString('en-US', { timeZone: TZ, weekday: 'long' });
  const localHour = parseInt(new Date().toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }), 10);
  mode = (localDay === 'Sunday' && localHour >= 20) ? 'weekly' : 'daily';
}

const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: TZ });

// =====================================================================
// PREFERENCES
// =====================================================================
const PREFS = {
  earliestHour:       6,
  latestHour:         21,
  daysAhead:          mode === 'weekly' ? 8 : 1,
  defaultDurationMin: 60,
  altGapHours:        4
};

// feelsIdeal = where this run type runs best (research-aligned 7-10°C sweet spot)
// feelsMin/feelsMax = where this run type is still tolerable (band edges)
// Asymmetry is intentional: more headroom on the warm side because acclimatized
// runners cope with heat better than the ideal would suggest, while extreme cold
// degrades performance more sharply.
const TYPE_RULES = {
  Easy:           { feelsMin: 4,  feelsMax: 18, feelsIdeal: 10, bufferMin: 15 },
  Long:           { feelsMin: 0,  feelsMax: 14, feelsIdeal: 7,  bufferMin: 25 },
  Tempo:          { feelsMin: 3,  feelsMax: 16, feelsIdeal: 9,  bufferMin: 20 },
  Interval:       { feelsMin: 3,  feelsMax: 16, feelsIdeal: 9,  bufferMin: 25 },
  'Time Trial':   { feelsMin: 2,  feelsMax: 14, feelsIdeal: 7,  bufferMin: 30 },
  'Rolling 400s': { feelsMin: 3,  feelsMax: 16, feelsIdeal: 9,  bufferMin: 25 },
  Fartlek:        { feelsMin: 3,  feelsMax: 16, feelsIdeal: 9,  bufferMin: 20 },
  'Hill Repeats': { feelsMin: 2,  feelsMax: 14, feelsIdeal: 7,  bufferMin: 25 },
  Progression:    { feelsMin: 3,  feelsMax: 15, feelsIdeal: 8,  bufferMin: 20 },
  Strength:       { feelsMin: 4,  feelsMax: 17, feelsIdeal: 10, bufferMin: 20 },
  default:        { feelsMin: 4,  feelsMax: 18, feelsIdeal: 10, bufferMin: 15 }
};

// =====================================================================
// 1. PARSE RUNNA
// =====================================================================
function parseDurationMin(desc) {
  if (!desc) return null;
  const block = desc.split('\n')[0];
  const re = /(\d+)\s*h(?:\s*(\d+)\s*m)?|(\d+)\s*m/g;
  let upper = null, m;
  while ((m = re.exec(block)) !== null) {
    const mins = m[1] !== undefined
      ? parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0)
      : parseInt(m[3], 10);
    if (upper === null || mins > upper) upper = mins;
  }
  return upper;
}

function parseRunna(e) {
  if (!e.start?.date) return null;
  let title = (e.summary || '').replace(/^[\p{Extended_Pictographic}\s]+/u, '').trim();
  title = title.replace(/\s*•\s*\d+(?:\.\d+)?\s*(km|mi)\s*$/i, '');

  const distMatch = title.match(/(\d+(?:\.\d+)?)\s*(km|mi)/i);
  const typeMatch = title.match(/(Easy|Long|Tempo|Interval|Time Trial|Rolling 400s|Fartlek|Hill Repeats|Progression|Strength)\s*Run/i);

  const typeKey = typeMatch ? typeMatch[1] : null;
  const rules   = TYPE_RULES[typeKey] || TYPE_RULES.default;
  const runMin  = parseDurationMin(e.description) ?? PREFS.defaultDurationMin;

  return {
    date:        e.start.date,
    title,
    distance:    distMatch ? distMatch[0] : null,
    type:        typeKey ? typeKey + ' Run' : 'Run',
    runMin,
    bufferMin:   rules.bufferMin,
    durationMin: runMin + rules.bufferMin,
    rules
  };
}

const runnaByDate = new Map();
for (const e of runnaRaw) {
  const r = parseRunna(e);
  if (r) runnaByDate.set(r.date, r);
}

// =====================================================================
// FILTER RUNS BASED ON MODE
// =====================================================================
const runsToConsider = new Map();
for (const [date, run] of runnaByDate) {
  if (mode === 'daily'  && date === todayLocal) runsToConsider.set(date, run);
  if (mode === 'weekly' && date >  todayLocal) runsToConsider.set(date, run);
}

// =====================================================================
// 2. PARSE GENERAL CALENDAR
// =====================================================================
const busyEvents = generalRaw
  .filter(e => e.start?.dateTime && e.end?.dateTime)
  .filter(e => e.creator?.displayName !== 'Runna' && e.organizer?.displayName !== 'Runna')
  .map(e => ({
    title: e.summary || '(no title)',
    start: new Date(e.start.dateTime),
    end:   new Date(e.end.dateTime)
  }));

function hasConflict(start, end) {
  return busyEvents.some(ev => start < ev.end && end > ev.start);
}

// =====================================================================
// 3. PARSE WEATHER
// =====================================================================
const w  = weatherRaw[0];
const wh = w.hourly;
const offsetSec = w.utc_offset_seconds ?? 0;
const sign = offsetSec >= 0 ? '+' : '-';
const abs  = Math.abs(offsetSec);
const tzSuffix = `${sign}${String(Math.floor(abs/3600)).padStart(2,'0')}:${String(Math.floor((abs%3600)/60)).padStart(2,'0')}`;

const hours = wh.time.map((t, i) => ({
  time:        new Date(`${t}:00${tzSuffix}`),
  localTime:   t,
  localDate:   t.slice(0, 10),
  localHour:   parseInt(t.slice(11, 13), 10),
  tempC:       wh.temperature_2m[i],
  feelsLikeC:  wh.apparent_temperature[i],
  precipProb:  wh.precipitation_probability[i],
  windKph:     wh.windspeed_10m[i],
  weatherCode: wh.weathercode[i]
}));

function toLocalString(date) {
  const ms = date.getTime() + offsetSec * 1000;
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

// =====================================================================
// 4. SCORING
// =====================================================================
function codePenalty(c) {
  if (c <= 3)               return 0;
  if (c === 45 || c === 48) return 5;
  if (c >= 51 && c <= 55)   return 15;
  if (c >= 56 && c <= 57)   return 25;
  if (c >= 61 && c <= 65)   return 30;
  if (c >= 66 && c <= 67)   return 45;
  if (c >= 71 && c <= 77)   return 35;
  if (c >= 80 && c <= 82)   return 30;
  if (c >= 85 && c <= 86)   return 40;
  if (c >= 95)              return 100;
  return 0;
}

function scoreHour(h, rules) {
  if (h.localHour < PREFS.earliestHour || h.localHour >= PREFS.latestHour) return null;

  let score = 100;
  const deductions = [];
  const deduct = (factor, amount, detail) => {
    if (amount <= 0.5) return;
    score -= amount;
    deductions.push({ factor, amount: -Math.round(amount), detail });
  };

  // ===== TEMPERATURE =====
  // feelsIdeal = sweet-spot center. sideRange = distance from ideal to whichever
  // band edge applies on this side. Asymmetric: cold side may differ from warm.
  // Penalty reaches exactly 12 at the band edge, then continues from 12 outside —
  // no discontinuity at the boundary.
  const idealCenter = rules.feelsIdeal;
  const distance    = Math.abs(h.feelsLikeC - idealCenter);
  const sideRange   = h.feelsLikeC < idealCenter
    ? idealCenter - rules.feelsMin
    : rules.feelsMax - idealCenter;

  if (distance <= sideRange) {
    const tolerance = sideRange * 0.2;
    if (distance > tolerance) {
      const overshoot = (distance - tolerance) / (sideRange - tolerance);
      deduct('temp', overshoot * 12, `feels ${h.feelsLikeC.toFixed(1)}°C`);
    }
  } else {
    if (h.feelsLikeC < rules.feelsMin) {
      deduct('cold', 12 + (rules.feelsMin - h.feelsLikeC) * 4, `feels ${h.feelsLikeC.toFixed(1)}°C`);
    } else {
      const heatMult = rules.bufferMin >= 25 ? 7 : 5;
      deduct('heat', 12 + (h.feelsLikeC - rules.feelsMax) * heatMult, `feels ${h.feelsLikeC.toFixed(1)}°C`);
    }
  }

  // ===== WEATHER CODE =====
  const codeAmt = codePenalty(h.weatherCode);
  if (codeAmt > 0) deduct('weather', codeAmt, `code ${h.weatherCode}`);

  // ===== PRECIPITATION =====
  // Soft above 15% (0.8/percentage), continues from 20 at the 40% boundary.
  if (h.precipProb > 15) {
    const amt = h.precipProb > 40
      ? 20 + (h.precipProb - 40) * 0.8
      : (h.precipProb - 15) * 0.8;
    deduct('precip', amt, `${h.precipProb}% chance`);
  }

  // ===== WIND =====
  // Soft above 8 kph (1.0/kph), continues from 17 at the 25 kph boundary.
  if (h.windKph > 8) {
    const amt = h.windKph > 25
      ? 17 + (h.windKph - 25) * 1.5
      : (h.windKph - 8) * 1.0;
    deduct('wind', amt, `${h.windKph.toFixed(0)} kph`);
  }

  return { total: Math.max(0, Math.round(score)), deductions };
}

// =====================================================================
// 5. MAIN LOOP
// =====================================================================
const cutoff = Date.now() + PREFS.daysAhead * 24 * 3600 * 1000;
const gapMs  = PREFS.altGapHours * 3600 * 1000;
const out    = [];

for (const [date, run] of runsToConsider) {
  const dayHours = hours.filter(h =>
    h.localDate === date &&
    h.time.getTime() >= Date.now() &&
    h.time.getTime() <= cutoff
  );
  if (dayHours.length === 0) continue;

  const slotMs       = run.durationMin * 60 * 1000;
  const hoursSpanned = Math.ceil(run.durationMin / 60);

  const candidates = [];
  for (let i = 0; i <= dayHours.length - hoursSpanned; i++) {
    const start = dayHours[i].time;
    const end   = new Date(start.getTime() + slotMs);

    const spanResults = [];
    let valid = true;
    for (let j = 0; j < hoursSpanned; j++) {
      const r = scoreHour(dayHours[i + j], run.rules);
      if (r === null) { valid = false; break; }
      spanResults.push(r);
    }
    if (!valid || spanResults.length === 0) continue;
    if (hasConflict(start, end)) continue;

    const avg = Math.round(
      spanResults.reduce((a, r) => a + r.total, 0) / spanResults.length
    );
    const allDeductions = spanResults.flatMap(r => r.deductions);
    const worstFactor = allDeductions.length
      ? allDeductions.slice().sort((a, b) => a.amount - b.amount)[0]
      : null;

    const h0         = dayHours[i];
    const startLocal = h0.localTime.replace('T', ' ');
    const endLocal   = toLocalString(end);

    candidates.push({
      startISO:   start.toISOString(),
      endISO:     end.toISOString(),
      startLocal,
      endLocal,
      score:      avg,
      worstFactor,
      weather: {
        tempC:       h0.tempC,
        feelsLikeC:  h0.feelsLikeC,
        precipProb:  h0.precipProb,
        windKph:     h0.windKph,
        weatherCode: h0.weatherCode
      }
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of candidates) {
    if (picked.length === 0) {
      picked.push({ ...c, label: 'primary' });
    } else if (picked.length < 2) {
      const distance = Math.abs(new Date(c.startISO) - new Date(picked[0].startISO));
      if (distance >= gapMs) {
        picked.push({ ...c, label: 'alternate' });
        break;
      }
    }
  }

  if (picked.length > 0) {
    const p = picked[0];
    const a = picked[1] || null;
    const pTime = `${p.startLocal.slice(11)}–${p.endLocal.slice(11)}`;
    const aTime = a ? `${a.startLocal.slice(11)}–${a.endLocal.slice(11)}` : null;

    out.push({
      mode,
      date,
      run,
      recommendation: p,
      alternate:      a,
      summary: `🏃 ${date} — ${run.title} (${run.runMin}min run + ${run.bufferMin}min buffer = ${run.durationMin}min slot). Best: ${pTime} · feels ${p.weather.feelsLikeC.toFixed(1)}°C, ${p.weather.precipProb}% precip, ${p.weather.windKph.toFixed(0)} kph wind · score ${p.score}/100${aTime ? ` · alt ${aTime} (${a.score})` : ''}`
    });
  } else {
    out.push({
      mode,
      date,
      run,
      recommendation: null,
      alternate:      null,
      summary: `⚠️ ${date} — ${run.title}: no free, weather-acceptable window found.`
    });
  }
}

out.sort((a, b) => a.date.localeCompare(b.date));

if (out.length === 0) {
  return [{ json: {
    mode,
    warning: mode === 'daily'
      ? '🛌 No run scheduled today — rest day!'
      : 'No runs scheduled for the upcoming week.'
  }}];
}

return out.map(r => ({ json: r }));
