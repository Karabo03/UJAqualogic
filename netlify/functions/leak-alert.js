// ============================================================
// AQUA LOGIC - LEAK ALERT
//
// This is the piece that makes an administrator's phone ring.
//
// Why it lives here and not in the website: the phone has to
// ring so that somebody goes and opens the dashboard, which
// means at that moment nobody has the dashboard open. A closed
// laptop cannot place a call. This runs on Netlify, awake all
// the time, whether or not anyone is looking at anything.
//
// It is called twice for one leak, in two different ways:
//
//   1. The ESP32 posts here the moment it confirms a leak and
//      knows the zone. That starts the chain.
//   2. Twilio posts back here when a call ends. If nobody
//      picked up, that is what rings the next administrator.
//
// No secrets are written in this file. Everything sensitive is
// read from Netlify environment variables, which are not in the
// repository and cannot be read from a browser.
// ============================================================
 
const TWILIO_SID    = process.env.TWILIO_SID;
const TWILIO_TOKEN  = process.env.TWILIO_TOKEN;
const TWILIO_FROM   = process.env.TWILIO_FROM;
// The database address is not a secret. It already sits in
// plain view inside app.js, because the browser needs it. It is
// written here rather than kept as a Netlify setting on purpose:
// Netlify scans published files for the values of its settings,
// finds this address in app.js, assumes a secret has leaked, and
// refuses to publish the site.
const DB_URL        = process.env.FIREBASE_DB_URL
                      || 'https://ujaqualogic-default-rtdb.firebaseio.com';
const DB_SECRET     = process.env.FIREBASE_DB_SECRET;  // database secret, lets this function bypass the rules
const ALERT_SECRET  = process.env.ALERT_SECRET;        // shared word the ESP32 sends so strangers cannot ring you
const SITE_URL      = process.env.URL || process.env.DEPLOY_URL; // Netlify sets this itself
 
// How long the phone rings before Twilio gives up and we move
// to the next person. Twenty seconds is about five rings.
const RING_SECONDS = 20;
 
// One leak means one round of calls. If the sensors flap, or the
// board resets, we do not want the phone ringing over and over.
// A second leak inside this window is logged but not called.
const COOLDOWN_MS = 5 * 60 * 1000;
 
const FN_PATH = '/.netlify/functions/leak-alert';
 
// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------
 
function reply(statusCode, body){
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
 
// Reads and writes against the Realtime Database over REST. The
// database secret is attached, which is how a server is allowed
// past the security rules that protect the browser side.
async function dbGet(path){
  const res = await fetch(`${DB_URL}/${path}.json?auth=${DB_SECRET}`);
  if(!res.ok) throw new Error(`database read failed on ${path}: ${res.status}`);
  return res.json();
}
async function dbPut(path, value){
  const res = await fetch(`${DB_URL}/${path}.json?auth=${DB_SECRET}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if(!res.ok) throw new Error(`database write failed on ${path}: ${res.status}`);
  return res.json();
}
async function dbPush(path, value){
  const res = await fetch(`${DB_URL}/${path}.json?auth=${DB_SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if(!res.ok) throw new Error(`database push failed on ${path}: ${res.status}`);
  return res.json();
}
 
// Anything Twilio speaks has to be safe inside XML.
function xmlEscape(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
 
function twilioAuthHeader(){
  return 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
}
 
async function twilioPost(resource, params){
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/${resource}.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': twilioAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(params).toString()
    }
  );
  const body = await res.json().catch(() => ({}));
  if(!res.ok){
    throw new Error(`twilio ${resource} failed: ${res.status} ${body.message || ''}`);
  }
  return body;
}
 
// ------------------------------------------------------------
// Who to ring
//
// The numbers are not typed in anywhere. They come from the
// accounts an administrator approved, so the call list keeps
// itself correct as people join and leave.
// ------------------------------------------------------------
async function approvedAdmins(){
  const users = (await dbGet('users')) || {};
 
  return Object.entries(users)
    .map(([uid, u]) => Object.assign({ uid }, u))
    .filter(u => u.status === 'approved')
    .filter(u => u.role === 'admin')
    .filter(u => typeof u.phone === 'string' && u.phone.trim().length >= 8)
    // Oldest account first, so the order is stable and everybody
    // knows who gets rung before whom.
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
 
// ------------------------------------------------------------
// What the phone says when it is answered
// ------------------------------------------------------------
function spokenAlert(zone, level){
  const where = zone ? `zone ${zone}` : 'the pipeline';
  const line  = `Aqua Logic alert. A leak has been detected in ${where}. `
              + (level != null ? `Reservoir level is ${Math.round(level)} percent. ` : '')
              + `Please open the dashboard and dispatch a technician.`;
 
  // Said twice with a pause, because the first few words of a
  // call are usually missed while the phone is being lifted.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="alice">${xmlEscape(line)}</Say>
  <Pause length="1"/>
  <Say voice="alice">${xmlEscape(line)}</Say>
</Response>`;
}
 
// ------------------------------------------------------------
// Ring one administrator, and tell Twilio to report back here
// when the call finishes so the chain can carry on.
// ------------------------------------------------------------
async function ringAdmin(admins, index, incident){
  const admin = admins[index];
 
  const callbackUrl = `${SITE_URL}${FN_PATH}`
    + `?stage=status`
    + `&idx=${index}`
    + `&incident=${encodeURIComponent(incident.id)}`
    + `&secret=${encodeURIComponent(ALERT_SECRET)}`;
 
  const call = await twilioPost('Calls', {
    To:                  admin.phone,
    From:                TWILIO_FROM,
    Twiml:               spokenAlert(incident.zone, incident.level),
    Timeout:             String(RING_SECONDS),
    StatusCallback:      callbackUrl,
    StatusCallbackEvent: 'completed',
    StatusCallbackMethod:'POST'
  });
 
  // Twilio accepted it, so the cooldown may now legitimately
  // start. Until this point a repeat attempt is welcome.
  await dbPut('alerts/current', Object.assign({}, incident, {
    placed: true, ringing: index
  }));
 
  await dbPush('alerts/log', {
    incident: incident.id,
    action:   'called',
    name:     `${admin.name || ''} ${admin.surname || ''}`.trim(),
    phone:    admin.phone,
    zone:     incident.zone || 0,
    callSid:  call.sid || '',
    at:       Date.now()
  });
 
  return call;
}
 
// Last resort. Nobody picked up, so everybody gets a text.
async function smsEveryone(admins, incident){
  const where = incident.zone ? `Zone ${incident.zone}` : 'the pipeline';
  const text  = `AQUA LOGIC: leak detected in ${where}. Nobody answered the call. `
              + `Open the dashboard and dispatch a technician.`;
 
  for(const admin of admins){
    try {
      await twilioPost('Messages', { To: admin.phone, From: TWILIO_FROM, Body: text });
      await dbPush('alerts/log', {
        incident: incident.id,
        action:   'sms',
        name:     `${admin.name || ''} ${admin.surname || ''}`.trim(),
        phone:    admin.phone,
        zone:     incident.zone || 0,
        at:       Date.now()
      });
    } catch (err) {
      console.error('SMS failed for', admin.phone, err.message);
    }
  }
}
 
// ============================================================
// STAGE ONE. The ESP32 says there is a leak.
// ============================================================
async function handleLeak(body){
  if(body.secret !== ALERT_SECRET){
    return reply(401, { error: 'bad secret' });
  }
 
  const zone  = Number(body.zone) || 0;
  const level = body.level == null ? null : Number(body.level);
 
  // Has the phone already rung recently? A flapping sensor or a
  // board reset must not turn into a phone that will not stop.
  //
  // Note the check on `placed`. The cooldown only counts once a
  // call has genuinely been accepted by Twilio. An attempt that
  // failed must not buy itself five minutes of silence, which is
  // exactly the trap this fell into: the first call failed, the
  // cooldown started anyway, and every retry was then suppressed
  // by the failure that came before it.
  const current = await dbGet('alerts/current');
  if(current && current.placed && current.startedAt
     && (Date.now() - current.startedAt) < COOLDOWN_MS){
    await dbPush('alerts/log', {
      incident: current.id,
      action:   'suppressed',
      reason:   'another leak was reported inside the cooldown window',
      zone,
      at:       Date.now()
    });
    return reply(200, { ok: true, called: false, reason: 'cooldown' });
  }
 
  const admins = await approvedAdmins();
  if(!admins.length){
    await dbPush('alerts/log', {
      incident: 'none',
      action:   'failed',
      reason:   'no approved administrator has a phone number on record',
      zone,
      at:       Date.now()
    });
    return reply(200, { ok: true, called: false, reason: 'no administrators to ring' });
  }
 
  const incident = {
    id:        'inc_' + Date.now(),
    zone,
    level,
    startedAt: Date.now(),
    stage:     'calling',
    ringing:   0,
    total:     admins.length
  };
  await dbPut('alerts/current', incident);
 
  // If Twilio refuses, the reason must not disappear into a log
  // nobody can reach. It is written into the database instead,
  // where it can be read from anywhere.
  try {
    await ringAdmin(admins, 0, incident);
  } catch (err) {
    const reason = String(err.message || err).slice(0, 300);
 
    await dbPush('alerts/log', {
      incident: incident.id,
      action:   'call-failed',
      reason,
      phone:    admins[0].phone,
      zone,
      at:       Date.now()
    });
 
    // Left without `placed`, so the next check is free to try
    // again rather than being blocked by this failure.
    await dbPut('alerts/current', Object.assign({}, incident, {
      stage: 'failed', reason
    }));
 
    return reply(200, { ok: false, called: false, reason });
  }
 
  return reply(200, { ok: true, called: true, ringing: admins[0].phone, incident: incident.id });
}
 
// ============================================================
// STAGE TWO. Twilio reports how a call ended.
//
// Answered, we stop. Not answered, we ring the next person. Out
// of people, everybody gets a text instead.
// ============================================================
async function handleCallStatus(query, form){
  if(query.secret !== ALERT_SECRET){
    return reply(401, { error: 'bad secret' });
  }
 
  const status   = form.CallStatus || '';
  const index    = Number(query.idx || 0);
  const incident = await dbGet('alerts/current');
 
  // A callback for an incident that has already moved on. Ignore
  // it rather than starting a second chain of calls.
  if(!incident || incident.id !== query.incident){
    return reply(200, { ok: true, ignored: 'stale callback' });
  }
 
  if(status === 'completed'){
    // Somebody picked up. Note that a call diverted to voicemail
    // also reports completed, so this is not proof a human heard
    // it. The SMS backstop is what covers that case.
    await dbPut('alerts/current', Object.assign({}, incident, {
      stage: 'answered', answeredAt: Date.now()
    }));
    await dbPush('alerts/log', {
      incident: incident.id, action: 'answered', zone: incident.zone || 0, at: Date.now()
    });
    return reply(200, { ok: true, stage: 'answered' });
  }
 
  // busy, no-answer, failed or canceled. Move down the list.
  const admins = await approvedAdmins();
  const next   = index + 1;
 
  if(next < admins.length){
    await dbPut('alerts/current', Object.assign({}, incident, { ringing: next }));
    await ringAdmin(admins, next, incident);
    return reply(200, { ok: true, stage: 'escalated', ringing: admins[next].phone });
  }
 
  await dbPut('alerts/current', Object.assign({}, incident, {
    stage: 'unanswered', endedAt: Date.now()
  }));
  await smsEveryone(admins, incident);
  return reply(200, { ok: true, stage: 'nobody answered, sms sent' });
}
 
// ============================================================
// ENTRY POINT
// ============================================================
exports.handler = async (event) => {
  // A quick check that every setting is present. Without this a
  // missing environment variable shows up as a confusing crash
  // in the middle of a real emergency.
  const missing = [
    ['TWILIO_SID', TWILIO_SID], ['TWILIO_TOKEN', TWILIO_TOKEN], ['TWILIO_FROM', TWILIO_FROM],
    ['FIREBASE_DB_SECRET', DB_SECRET], ['ALERT_SECRET', ALERT_SECRET]
  ].filter(([, v]) => !v).map(([k]) => k);
 
  if(missing.length){
    console.error('Missing environment variables:', missing.join(', '));
    return reply(500, { error: 'not configured', missing });
  }
 
  if(event.httpMethod !== 'POST'){
    return reply(405, { error: 'post only' });
  }
 
  const query = event.queryStringParameters || {};
 
  try {
    if(query.stage === 'status'){
      // Twilio posts form encoded, not JSON.
      const form = Object.fromEntries(new URLSearchParams(event.body || ''));
      return await handleCallStatus(query, form);
    }
 
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return reply(400, { error: 'body must be json' }); }
 
    return await handleLeak(body);
 
  } catch (err) {
    console.error('leak-alert failed:', err);
    return reply(500, { error: err.message });
  }
};
 


