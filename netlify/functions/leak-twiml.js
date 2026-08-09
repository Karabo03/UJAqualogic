// ============================================================
// AQUA LOGIC - WHAT THE PHONE SAYS
//
// Twilio asks this address what to say the moment the call is
// answered, and reads the answer out loud.
//
// This exists because of a trial account restriction. The tidy
// way is to hand Twilio the words directly when placing the
// call, but a trial account rejects that with "invalid or
// disallowed parameters". It will happily fetch a web address
// instead, so the words live here.
//
// Nothing secret is here, and nothing can be triggered from it.
// It only ever returns a sentence.
// ============================================================
 
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
 
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
 
  const zone  = Number(q.zone) || 0;
  const level = q.level == null || q.level === '' ? null : Number(q.level);
 
  const where = zone ? `zone ${zone}` : 'the pipeline';
 
  const line = `Aqua Logic alert. A leak has been detected in ${where}. `
             + (level != null && !isNaN(level) ? `Reservoir level is ${Math.round(level)} percent. ` : '')
             + `Please open the dashboard and dispatch a technician.`;
 
  // Said twice with pauses. The first second of a call is always
  // lost while the phone is being picked up, so a message said
  // once is a message half heard.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="alice">${xmlEscape(line)}</Say>
  <Pause length="1"/>
  <Say voice="alice">${xmlEscape(line)}</Say>
</Response>`;
 
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: twiml
  };
};
 


