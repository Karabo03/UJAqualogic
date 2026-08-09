// ============================================================
// AQUA LOGIC - LEAK WATCHER
//
// Wakes up once a minute and looks at the leak value the board
// is already writing into Firebase. If a leak is up, it asks
// leak-alert to start ringing.
//
// Why this exists. The plan was for the board to call Netlify
// itself, which is instant. On the Wokwi simulator that does not
// work: the board resolves the address fine and reaches the wider
// internet fine, but cannot finish an encrypted handshake with
// Netlify. Rather than fight the simulator, this watcher uses only
// the two paths already proven to work. The board writes to
// Firebase, and Netlify reads it.
//
// The cost is delay. A leak is noticed within a minute instead of
// within two seconds. Everything after that is unchanged.
//
// This does not decide anything by itself. It only reports the
// leak to leak-alert, which owns the cooldown, the call list and
// the escalation. One place makes the decisions.
// ============================================================
 
const DB_URL       = process.env.FIREBASE_DB_URL
                     || 'https://ujaqualogic-default-rtdb.firebaseio.com';
const DB_SECRET    = process.env.FIREBASE_DB_SECRET;
const ALERT_SECRET = process.env.ALERT_SECRET;
const SITE_URL     = process.env.URL || 'https://ujaqualogic.netlify.app';
 
// Writes a note into the database saying what happened on this
// run. Netlify's own log cannot be read from everywhere, and a
// watcher that is silent because it never woke up looks exactly
// like a watcher that is silent because it saw nothing wrong.
// This tells the two apart.
async function heartbeat(note) {
  try {
    await fetch(`${DB_URL}/alerts/heartbeat.json?auth=${DB_SECRET}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ at: Date.now() }, note))
    });
  } catch (err) {
    console.error('heartbeat failed:', err.message);
  }
}
 
// Hands the situation to leak-alert, which owns every decision
// about who gets rung and when. This only reports what it saw.
async function reportToAlert(payload) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/leak-alert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ secret: ALERT_SECRET }, payload))
  });
  return { status: res.status, raw: (await res.text()).slice(0, 500) };
}
 
exports.handler = async () => {
  if (!DB_SECRET || !ALERT_SECRET) {
    console.error('leak-watch is missing FIREBASE_DB_SECRET or ALERT_SECRET');
    return { statusCode: 500 };
  }
 
  await heartbeat({ stage: 'woke up' });
 
  try {
    // One read of the whole node, so the leak and the tank level
    // are guaranteed to come from the same moment.
    const res = await fetch(`${DB_URL}/aqualogic.json?auth=${DB_SECRET}`);
    if (!res.ok) {
      await heartbeat({ stage: 'could not read the database', status: res.status });
      return { statusCode: 500 };
    }
 
    const data = (await res.json()) || {};
    const leak = data.leak || {};
 
    // A quiet minute is reported too, not just a leaking one.
    // That is what lets leak-alert close an incident when the
    // water stops, so the next leak counts as a new one and rings
    // properly instead of being mistaken for the old one.
    if (!leak.detected) {
      await reportToAlert({ leaking: false });
      await heartbeat({ stage: 'ran, no leak' });
      return { statusCode: 200 };
    }
 
    const zone  = Number(leak.zone) || 0;
    const level = data.tank && data.tank.level != null
                  ? Number(data.tank.level)
                  : null;
 
    await heartbeat({ stage: 'leak seen, calling leak-alert', zone, level });
 
    // Hand it to leak-alert exactly as the board would have. It
    // will ignore this if it has already rung for the same leak,
    // so a leak lasting ten minutes still only rings once.
    // The reply is read as plain text, not JSON. If leak-alert
    // ever crashes, what comes back is an error page rather than
    // JSON, and that page is exactly the thing worth seeing.
    const handover = await reportToAlert({ leaking: true, zone, level });
 
    await heartbeat({
      stage:  'leak-alert replied',
      zone,
      status: handover.status,
      reply:  handover.raw
    });
 
    return { statusCode: 200 };
 
  } catch (err) {
    await heartbeat({ stage: 'leak-watch itself failed', error: String(err.message).slice(0, 300) });
    return { statusCode: 500 };
  }
};
 


