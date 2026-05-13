// =====================================================================
// Format Email
// =====================================================================
// n8n Code node — final stage before the Gmail node.
// Handles both daily and weekly paths through the IF/Gemini split.
// In weekly mode the upstream input is Gemini's LLM text; recommendations
// are pulled from FOW via cross-node reference. In daily mode the upstream
// input is FOW directly.
// =====================================================================

let items;
let coachNote = '';

try {
  const gemini = $('Gemini-Agent').first()?.json;
  if (gemini?.content?.parts?.[0]?.text) {
    coachNote = gemini.content.parts[0].text.trim();
    items = $('Find Optimal Running Window').all().map(i => i.json);
  }
} catch (e) {
  // Gemini-Agent didn't execute (daily mode) — fall through
}

if (!items) {
  items = $input.all().map(i => i.json);
}

// =====================================================================
// HELPERS
// =====================================================================
const fmtScoreColor = s => s >= 80 ? '#28a745' : s >= 60 ? '#ffc107' : '#dc3545';

const cleanTitle = t => (t || '').replace(/\s*•\s*\d+(?:\.\d+)?\s*(km|mi)\s*$/i, '');

function fmtDate(iso) {
  const tz    = 'America/Montreal';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const tmrw  = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: tz });
  if (iso === today) return 'Today';
  if (iso === tmrw)  return 'Tomorrow';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: tz
  });
}

// =====================================================================
// EMPTY / REST-DAY EARLY RETURN
// =====================================================================
if (items.length === 1 && items[0].warning) {
  const isDailyRest = items[0].mode === 'daily';
  return [{ json: {
    subject: isDailyRest ? '🛌 Rest day' : '🏃 Running plan — no runs found',
    html:    `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;color:#555;padding:20px;">${items[0].warning}</p>`,
    text:    items[0].warning
  }}];
}

// =====================================================================
// ROW BUILDER
// =====================================================================
function buildRows(r) {
  if (!r.recommendation) {
    return `<tr><td colspan="4" style="padding:10px;background:#fff8e1;border:1px solid #ffe082;">
      ⚠️ <strong>${fmtDate(r.date)}</strong> — ${cleanTitle(r.run.title)}: no free, weather-acceptable window found.
    </td></tr>`;
  }

  const p    = r.recommendation;
  const wf   = p.worstFactor;
  const time = `${p.startLocal.slice(11)}–${p.endLocal.slice(11)}`;

  const scoreCell = `
    <strong style="color:${fmtScoreColor(p.score)};font-size:20px;">${p.score}</strong>
    ${wf ? `<br><span style="color:#999;font-size:12px;">${wf.factor} ${wf.amount}<br>(${wf.detail})</span>` : ''}
  `;

  const primaryRow = `<tr>
    <td style="padding:10px;border:1px solid #ddd;vertical-align:top;">
      <strong>${fmtDate(r.date)}</strong><br>
      <span style="color:#666;font-size:13px;">${cleanTitle(r.run.title)}</span>
    </td>
    <td style="padding:10px;border:1px solid #ddd;vertical-align:top;white-space:nowrap;">
      <strong style="font-size:16px;">${time}</strong><br>
      <span style="color:#666;font-size:13px;">${r.run.durationMin}min slot</span>
    </td>
    <td style="padding:10px;border:1px solid #ddd;vertical-align:top;">
      Feels <strong>${p.weather.feelsLikeC.toFixed(1)}°C</strong><br>
      <span style="color:#666;font-size:13px;">${p.weather.precipProb}% precip · ${p.weather.windKph.toFixed(0)} kph wind</span>
    </td>
    <td style="padding:10px;border:1px solid #ddd;text-align:center;vertical-align:top;">
      ${scoreCell}
    </td>
  </tr>`;

  let altRow = '';
  if (r.alternate) {
    const a     = r.alternate;
    const aTime = `${a.startLocal.slice(11)}–${a.endLocal.slice(11)}`;
    const awf   = a.worstFactor;

    const aScoreCell = `
      <strong style="color:${fmtScoreColor(a.score)};font-size:16px;">${a.score}</strong>
      ${awf ? `<br><span style="color:#999;font-size:11px;">${awf.factor} ${awf.amount}</span>` : ''}
    `;

    altRow = `<tr style="background:#fafafa;">
      <td style="padding:8px 10px;border:1px solid #ddd;color:#999;font-size:12px;font-style:italic;">↳ alternate</td>
      <td style="padding:8px 10px;border:1px solid #ddd;color:#555;white-space:nowrap;"><strong>${aTime}</strong></td>
      <td style="padding:8px 10px;border:1px solid #ddd;color:#666;font-size:13px;">
        Feels ${a.weather.feelsLikeC.toFixed(1)}°C · ${a.weather.precipProb}% · ${a.weather.windKph.toFixed(0)} kph
      </td>
      <td style="padding:8px 10px;border:1px solid #ddd;text-align:center;">${aScoreCell}</td>
    </tr>`;
  }

  return primaryRow + altRow;
}

// =====================================================================
// MODE-AWARE SUBJECT + HEADER
// =====================================================================
const mode = items[0]?.mode || 'daily';
const recs = items.filter(i => i.recommendation);

let subject, headerLine, headerTitle;
if (recs.length === 0) {
  subject     = mode === 'weekly' ? '🏃 Rest week — no runs scheduled' : '🛌 Rest day';
  headerTitle = mode === 'weekly' ? 'Week Ahead' : 'Today';
  headerLine  = mode === 'weekly'
    ? 'No runs scheduled for the upcoming week.'
    : 'No run scheduled today.';
} else if (mode === 'daily') {
  const r     = recs[0];
  const range = `${r.recommendation.startLocal.slice(11)}–${r.recommendation.endLocal.slice(11)}`;
  subject     = `🏃 Today's run · ${range}`;
  headerTitle = "Today's Run";
  headerLine  = "Here's your window for today:";
} else {
  // weekly
  const best  = recs.reduce((a, b) =>
    a.recommendation.score >= b.recommendation.score ? a : b
  );
  subject     = `🏃 ${recs.length} runs this week · best ${fmtDate(best.date)} (${best.recommendation.score})`;
  headerTitle = 'Week Ahead';
  headerLine  = `Plan for the upcoming week — ${recs.length} run${recs.length > 1 ? 's' : ''} queued. Standout: ${fmtDate(best.date)} (${best.recommendation.score}/100).`;
}

// =====================================================================
// COACH'S NOTE BLOCK (weekly only — empty string when no Gemini output)
// =====================================================================
const coachNoteBlock = coachNote ? `
  <div style="background:#fdf6e3;border-left:3px solid #b58900;padding:14px 18px;margin:18px 0 22px;border-radius:6px;">
    <p style="margin:0 0 6px;font-weight:600;color:#7a5a1c;font-size:13px;letter-spacing:0.4px;">📋 COACH'S NOTE</p>
    <p style="margin:0;color:#444;font-size:14px;line-height:1.55;">${coachNote}</p>
  </div>
` : '';

// =====================================================================
// EMAIL ASSEMBLY
// =====================================================================
const rows = items.map(buildRows).join('');

const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#333;max-width:680px;margin:0 auto;padding:20px;">
  <h2 style="color:#0066cc;border-bottom:2px solid #0066cc;padding-bottom:8px;margin-bottom:16px;">🏃 ${headerTitle}</h2>
  <p style="color:#555;">${headerLine}</p>
  ${coachNoteBlock}
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <thead>
      <tr style="background:#f5f5f5;">
        <th style="padding:10px;border:1px solid #ddd;text-align:left;">Day & Run</th>
        <th style="padding:10px;border:1px solid #ddd;text-align:left;">Best Time</th>
        <th style="padding:10px;border:1px solid #ddd;text-align:left;">Conditions</th>
        <th style="padding:10px;border:1px solid #ddd;text-align:center;">Score</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="color:#999;font-size:12px;margin-top:14px;">
    Score: <span style="color:#28a745;">●</span> 80+ excellent ·
    <span style="color:#ffc107;">●</span> 60–79 acceptable ·
    <span style="color:#dc3545;">●</span> &lt;60 marginal.
    The label under the score names the factor that cost the most points (heat/cold/wind/precip/weather).
  </p>
  <p style="margin-top:20px;color:#999;font-size:12px;">
    Generated ${new Date().toLocaleString('en-CA', { timeZone: 'America/Montreal', dateStyle: 'full', timeStyle: 'short' })}
  </p>
</body></html>`;

const text = items.map(r => r.summary || r.warning).join('\n')
  + (coachNote ? `\n\nCoach's note: ${coachNote}` : '');

return [{ json: { subject, html, text } }];
