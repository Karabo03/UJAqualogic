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
 
exports.handler = async () => {
  if (!DB_SECRET || !ALERT_SECRET) {
    console.error('leak-watch is missing FIREBASE_DB_SECRET or ALERT_SECRET');
    return { statusCode: 500 };
  }
 
  try {
    // One read of the whole node, so the leak and the tank level
    // are guaranteed to come from the same moment.
    const res = await fetch(`${DB_URL}/aqualogic.json?auth=${DB_SECRET}`);
    if (!res.ok) {
      console.error('could not read the database:', res.status);
      return { statusCode: 500 };
    }
 
    const data = (await res.json()) || {};
    const leak = data.leak || {};
 
    if (!leak.detected) {
      // Nothing wrong. Say so in the log so a quiet minute is
      // distinguishable from a watcher that never ran.
      console.log('no leak');
      return { statusCode: 200 };
    }
 
    const zone  = Number(leak.zone) || 0;
    const level = data.tank && data.tank.level != null
                  ? Number(data.tank.level)
                  : null;
 
    console.log(`leak seen in zone ${zone}, handing over to leak-alert`);
 
    // Hand it to leak-alert exactly as the board would have. It
    // will ignore this if it has already rung for the same leak,
    // so a leak lasting ten minutes still only rings once.
    const handover = await fetch(`${SITE_URL}/.netlify/functions/leak-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: ALERT_SECRET, zone, level })
    });
 
    const result = await handover.json().catch(() => ({}));
    console.log('leak-alert replied:', JSON.stringify(result));
 
    return { statusCode: 200 };
 
  } catch (err) {
    console.error('leak-watch failed:', err.message);
    return { statusCode: 500 };
  }
};
 
