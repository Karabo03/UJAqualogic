// ============================================================
// AQUA LOGIC - DISPATCH A TECHNICIAN
//
// The operator presses one button on the dashboard. That button
// does two jobs, because they are one human action:
//
//   1. Says "I have seen this leak", which stops the phone
//      ringing every five minutes.
//   2. Tells the technician to go, by phone and by text.
//
// The email is sent by the dashboard itself through EmailJS, so
// it is not handled here.
//
// SECURITY. This function can spend money and can phone real
// people, so it will not take anyone's word for who they are.
// The browser sends the signed-in user's Firebase token, and this
// checks the signature against Google's own public keys before
// looking at anything else. Then it checks that user really is an
// approved administrator in the database. A stranger who finds
// this address can do nothing with it.
// ============================================================
 
const crypto = require('crypto');
 
const TWILIO_SID   = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_FROM;
const DB_URL       = process.env.FIREBASE_DB_URL
                     || 'https://ujaqualogic-default-rtdb.firebaseio.com';
const DB_SECRET    = process.env.FIREBASE_DB_SECRET;
const SITE_URL     = process.env.URL || 'https://ujaqualogic.netlify.app';
 
// Taken from the database address, so there is one place to change
// it if the project is ever renamed.
const PROJECT_ID = (DB_URL.match(/\/\/([a-z0-9-]+?)(-default-rtdb)?\./) || [])[1] || 'ujaqualogic';
 
const GOOGLE_KEYS =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
 
// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
 
function reply(statusCode, body){
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}
 
async function dbGet(path){
  const res = await fetch(`${DB_URL}/${path}.json?auth=${DB_SECRET}`);
  if(!res.ok) throw new Error(`database read failed on ${path}: ${res.status}`);
  return res.json();
}
async function dbPatch(path, value){
  const res = await fetch(`${DB_URL}/${path}.json?auth=${DB_SECRET}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if(!res.ok) throw new Error(`database write failed on ${path}: ${res.status}`);
  return res.json();
}
async function dbPush(path, value){
  await fetch(`${DB_URL}/${path}.json?auth=${DB_SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
}
 
async function twilioPost(resource, params){
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/${resource}.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(params).toString()
    }
  );
  const body = await res.json().catch(() => ({}));
  if(!res.ok) throw new Error(`${res.status} ${body.message || 'twilio refused the request'}`);
  return body;
}
 
// ------------------------------------------------------------
// Proving who is asking
// ------------------------------------------------------------
 
function fromBase64Url(s){
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
 
// Checks a Firebase sign-in token the way Firebase itself would.
// The signature is what matters. Anyone can write a token claiming
// to be an administrator, but only Google can sign one, and the
// public half of Google's key is what proves it.
async function verifyIdToken(token){
  const parts = String(token || '').split('.');
  if(parts.length !== 3) throw new Error('the sign-in token is malformed');
 
  const [rawHeader, rawPayload, rawSignature] = parts;
  const header  = JSON.parse(fromBase64Url(rawHeader).toString());
  const payload = JSON.parse(fromBase64Url(rawPayload).toString());
 
  const certs = await (await fetch(GOOGLE_KEYS)).json();
  const cert  = certs[header.kid];
  if(!cert) throw new Error('the token was signed with a key Google does not publish');
 
  const signatureIsGood = crypto
    .createVerify('RSA-SHA256')
    .update(`${rawHeader}.${rawPayload}`)
    .verify(cert, fromBase64Url(rawSignature));
 
  if(!signatureIsGood) throw new Error('the token signature does not match');
 
  const now = Math.floor(Date.now() / 1000);
  if(payload.exp <= now)   throw new Error('the sign-in has expired, please sign in again');
  if(payload.aud !== PROJECT_ID) throw new Error('the token belongs to a different project');
  if(payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new Error('unexpected issuer');
  if(!payload.sub)         throw new Error('the token names no user');
 
  return payload;
}
 
// ------------------------------------------------------------
// What the technician hears
// ------------------------------------------------------------
function speechUrl(tech, zone){
  return `${SITE_URL}/.netlify/functions/leak-twiml`
    + `?tech=${encodeURIComponent(tech.name || 'technician')}`
    + `&zone=${encodeURIComponent(zone || 0)}`;
}
 
function textMessage(tech, zone, sentBy){
  const where = zone ? `Zone ${zone}` : 'the pipeline';
  return `AQUA LOGIC DISPATCH\n`
       + `${tech.name || 'Technician'}, you have been assigned a leak in ${where}.\n`
       + `Dispatched by ${sentBy}.\n`
       + `Open the dashboard for details.`;
}
 
// ============================================================
// ENTRY POINT
// ============================================================
exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 204, headers: { 'Access-Control-Allow-Headers': 'Authorization, Content-Type' } };
  }
  if(event.httpMethod !== 'POST'){
    return reply(405, { error: 'post only' });
  }
 
  const missing = [
    ['TWILIO_SID', TWILIO_SID], ['TWILIO_TOKEN', TWILIO_TOKEN],
    ['TWILIO_FROM', TWILIO_FROM], ['FIREBASE_DB_SECRET', DB_SECRET]
  ].filter(([, v]) => !v).map(([k]) => k);
 
  if(missing.length){
    console.error('Missing environment variables:', missing.join(', '));
    return reply(500, { error: 'not configured', missing });
  }
 
  try {
    // ---- 1. Who is asking? -------------------------------
    const header = event.headers.authorization || event.headers.Authorization || '';
    const token  = header.replace(/^Bearer\s+/i, '');
 
    let claims;
    try {
      claims = await verifyIdToken(token);
    } catch (err) {
      return reply(401, { error: err.message });
    }
 
    // ---- 2. Are they allowed to do this? -----------------
    const caller = await dbGet(`users/${claims.sub}`);
    if(!caller || caller.status !== 'approved' || caller.role !== 'admin'){
      return reply(403, { error: 'only an approved administrator can dispatch' });
    }
 
    const sentBy = `${caller.name || ''} ${caller.surname || ''}`.trim() || claims.email || 'an administrator';
 
    // ---- 3. Who are we sending? --------------------------
    const body = JSON.parse(event.body || '{}');
    const technicianId = body.technicianId;
    if(!technicianId) return reply(400, { error: 'no technician was chosen' });
 
    const tech = await dbGet(`users/${technicianId}`);
    if(!tech || tech.status !== 'approved'){
      return reply(400, { error: 'that technician is not an approved user' });
    }
    if(!tech.phone || String(tech.phone).trim().length < 8){
      return reply(400, { error: `${tech.name || 'that technician'} has no phone number on record` });
    }
 
    const zone = Number(body.zone) || 0;
 
    // ---- 4. Stop the phone ringing -----------------------
    // Done before the calls, deliberately. If Twilio fails, the
    // operator has still seen the leak, and ringing them every
    // five minutes about a leak they are actively dealing with
    // helps nobody.
    const current = await dbGet('alerts/current');
    if(current && current.id && !current.closedAt){
      await dbPatch('alerts/current', {
        acknowledged:   true,
        acknowledgedBy: sentBy,
        acknowledgedAt: Date.now()
      });
      await dbPush('alerts/log', {
        incident: current.id,
        action:   'acknowledged',
        by:       sentBy,
        zone,
        at:       Date.now()
      });
    }
 
    // ---- 5. Send the technician -------------------------
    // The call and the text are tried separately so that one
    // failing does not silently cancel the other. A technician
    // who got a text but no call is far better off than one who
    // got nothing because the call leg was rejected.
    const sent = { call: null, sms: null };
 
    try {
      const call = await twilioPost('Calls', {
        To:   tech.phone,
        From: TWILIO_FROM,
        Url:  speechUrl(tech, zone)
      });
      sent.call = { ok: true, sid: call.sid };
    } catch (err) {
      sent.call = { ok: false, reason: String(err.message).slice(0, 300) };
    }
 
    try {
      const sms = await twilioPost('Messages', {
        To:   tech.phone,
        From: TWILIO_FROM,
        Body: textMessage(tech, zone, sentBy)
      });
      sent.sms = { ok: true, sid: sms.sid };
    } catch (err) {
      sent.sms = { ok: false, reason: String(err.message).slice(0, 300) };
    }
 
    await dbPush('alerts/log', {
      incident:   current && current.id ? current.id : 'none',
      action:     'dispatched',
      technician: tech.name || '',
      phone:      tech.phone,
      by:         sentBy,
      zone,
      call:       sent.call.ok ? 'sent' : `failed: ${sent.call.reason}`,
      sms:        sent.sms.ok  ? 'sent' : `failed: ${sent.sms.reason}`,
      at:         Date.now()
    });
 
    return reply(200, {
      ok: sent.call.ok || sent.sms.ok,
      acknowledged: true,
      technician: tech.name || '',
      phone: tech.phone,
      call: sent.call,
      sms: sent.sms
    });
 
  } catch (err) {
    console.error('notify-technician failed:', err);
    return reply(500, { error: err.message });
  }
};
 





