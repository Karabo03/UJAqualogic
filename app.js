// ============================================================
// AQUA LOGIC - APPLICATION SCRIPT
// All behaviour for the public site and the dashboard.
// Loaded at the bottom of index.html, after the page has been
// built, so every element it touches already exists.
// ============================================================

// ============================================================
// FIREBASE SETUP
// This connects the dashboard to the same Realtime Database
// the ESP32 writes to.
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyDMbm0-d845ktQCKCrQKGuIIuB22wo9a1A",
  authDomain: "ujaqualogic.firebaseapp.com",
  databaseURL: "https://ujaqualogic-default-rtdb.firebaseio.com",
  projectId: "ujaqualogic",
  storageBucket: "ujaqualogic.firebasestorage.app",
  messagingSenderId: "626677198098",
  appId: "1:626677198098:web:9910e571a9290b738bd7cb",
  measurementId: "G-MF9C097FJY"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const rtdb = firebase.database();
let recaptchaVerifier = null;
let confirmationResult = null;
(function () {
  emailjs.init("njE3wzHhlXzpcVbHf");
})();

// ============================================================
// CONSTANTS AND APP STATE
// ============================================================
const $ = (id) => document.getElementById(id);

// ============================================================
// ACCOUNT STATUS
// Registering does not create access. It creates a request.
// Every account sits at one of these four states, and the
// state lives in the database, never in this file.
//
//   pending   Waiting for an administrator to look at it.
//   approved  Can sign in and open the dashboard.
//   declined  Was refused. Cannot sign in.
//   suspended Was approved once and has since been switched off.
//
// Only an approved administrator can move an account from one
// state to another. The database rules enforce that, so it
// cannot be faked from the browser console.
// ============================================================
// ============================================================
// CONTROL ROOM ADDRESS
// The one inbox that is watched whether or not somebody is
// signed into the dashboard. Fault reports and public leak
// reports both copy it, so nothing is missed overnight.
// ============================================================
const CONTROL_ROOM_EMAIL = 'info@ujaqualogic.co.za';

// EmailJS service and templates. Kept together so there is one
// place to change them.
const MAIL = {
  service:      'service_pljtgtf',
  otp:          'template_j20o1f6',
  fault:        'template_fault',
  // Create this one in EmailJS to have public reports copied to
  // the control room inbox. Until it exists the copy is skipped
  // and the report still saves to the database as normal.
  publicReport: 'template_report'
};

const STATUS = {
  PENDING:   'pending',
  APPROVED:  'approved',
  DECLINED:  'declined',
  SUSPENDED: 'suspended'
};

// What the person is told when their account is not approved.
const STATUS_MESSAGE = {
  [STATUS.PENDING]:   ['⏳ Waiting for approval', 'Your access request has not been reviewed yet. An administrator will approve it and you will be able to sign in.'],
  [STATUS.DECLINED]:  ['🔒 Request declined', 'Your access request was not approved. Contact the administrator at info@ujaqualogic.co.za if you believe this is a mistake.'],
  [STATUS.SUSPENDED]: ['🔒 Account suspended', 'This account has been switched off by an administrator. Contact info@ujaqualogic.co.za.']
};

// ============================================================
// ROLES
// Two kinds of account. The administrator runs the control
// room. Maintenance goes out and fixes the pipe. Both open the
// same dashboard, the role only decides which buttons appear.
//
// The registration form asks which one the person is applying
// for, but that is a request, not a decision. The role that
// counts is the one an administrator sets when approving, so
// nobody can hand themselves administrator rights by picking
// it from a dropdown.
// ============================================================
const ROLE_HINTS = {
  admin:       'Administrator accounts run the control room. They see every screen and can approve new accounts, dispatch jobs and close them.',
  maintenance: 'Maintenance accounts join the call out rotation, so leaks get shared out evenly. You will be called when it is your turn.'
};
function roleHint(){
  const sel = $('rg-role');
  const box = $('roleHintBox');
  if(sel && box) box.textContent = ROLE_HINTS[sel.value] || '';
}
function isAdmin(){
  // Strict. An account is an administrator only when the role
  // was written as 'admin' by another administrator. Anything
  // else, including a missing role, is treated as maintenance.
  return APP.user?.role === 'admin';
}

const ZONES = [
  {id:'A', num:1, name:'Zone Alpha',   desc:'Northern Sector'},
  {id:'B', num:2, name:'Zone Beta',    desc:'Central Pipeline'},
  {id:'C', num:3, name:'Zone Charlie', desc:'Southern Grid'}
];
// ============================================================
// PRESSURE SETTINGS
// These mirror the Arduino sketch. readPressureSensors() maps
// each pot from 0-4095 to 0-1000, and the OLED divides by 100
// to show bar. So 1000 in Firebase means 10.00 bar.
// ============================================================
const PRESSURE_RAW_MAX  = 1000;
const PRESSURE_DIVISOR  = 100;
const PRESSURE_UNIT     = 'bar';
const LEAK_DROP_RAW     = 100;   // 1.00 bar, same as detectLeak()
const PRESSURE_DECIMALS = 2;     // set to 1 to match the OLED exactly
const PRESSURE_POINTS = [
  { key:'p0', tag:'P0', name:'Pipeline Inlet' },
  { key:'p1', tag:'P1', name:'After Zone A' },
  { key:'p2', tag:'P2', name:'After Zone B' },
  { key:'p3', tag:'P3', name:'Pipeline Outlet' }
];
// ============================================================
// FLOW SETTINGS
// Rate of water past each flow sensor, in litres per minute.
// readFlowSensors() maps each pot from 0-4095 to 0-100, so
// 100 in Firebase means 100 L/min.
// F1 sits at the reservoir outlet, F2 at the pipeline end.
// Water going in faster than it comes out is the clearest
// physical sign of a leak, so the gap gets its own tile.
// ============================================================
const FLOW_UNIT       = 'L/min';
const FLOW_MAX        = 100;  // matches map(raw,0,4095,0,100) in the sketch
const FLOW_DIVISOR    = 1;    // set to 10 if the ESP32 ever sends L/min x10
const FLOW_DECIMALS   = 1;
const FLOW_LOSS_LIMIT = 10;   // same threshold as detectLeak() in the sketch
// Which two pressure points sit either side of each zone.
// Matches determineLeakZone() in the sketch: zone 1 is the
// drop from P0 to P1, zone 2 from P1 to P2, zone 3 from P2 to P3.
const ZONE_SEGMENTS = { A:['p0','p1'], B:['p1','p2'], C:['p2','p3'] };
function toBar(raw){
  return Number(raw) / PRESSURE_DIVISOR;
}
function barText(raw){
  return toBar(raw).toFixed(PRESSURE_DECIMALS);
}
const APP = {
  user: null,
  pendingReg: null,
  pendingLogin: null,
  emailOTP: '',
  authStep: 'login',
  incidentLog: [],
  leakZones: [],
  autoEmail: true,
  silenceUntil: 0,
  lastEmailSentAt: 0,
  escalationsSent: {},
  lastAlertKey: null,   // which zones were red the last time we raised the alarm
  forcedLeakZone: null,
  forcedLeakUntil: 0,   // demo leaks expire, see simulateLeak()
  activeFilter: 'all',
  liveData: null,
  faultReport: null,
  deviceOnline: false,
  liveListenerActive: false,

  // Citizen reports and the maintenance team
  reports: [],          // everything under /reports, newest first
  reportFilter: 'all',
  seenReportIds: [],     // used to spot arrivals and toast them
  team: [],              // everything under /team
  accessRequests: [],    // every account under /users, admins only
  seenRequestIds: [],    // used to toast an administrator when a new one lands
  userFilter: 'pending', // which tab of the access requests panel is showing
  dispatch: null,        // the assignment shown on the dispatch card
  assignedForKey: null,  // stops one leak assigning a tech twice
  lastLeakRenderKey: null // redraws report cards when the sensors change
};
const PW_RULES = [
  { id:'len',   label:'8+ characters', test: p => p.length >= 8 },
  { id:'upper', label:'Uppercase letter', test: p => /[A-Z]/.test(p) },
  { id:'lower', label:'Lowercase letter', test: p => /[a-z]/.test(p) },
  { id:'digit', label:'Number 0 to 9', test: p => /\d/.test(p) },
  { id:'spec',  label:'Special character', test: p => /[^A-Za-z0-9]/.test(p) },
  { id:'nosp',  label:'No spaces', test: p => !/\s/.test(p) && p.length > 0 }
];
const FAQS = [
  {q:"What is Aqua Logic?",a:"Aqua Logic is a smart water intelligence platform that monitors water infrastructure in real time, tracks reservoir levels, and detects leaks across Zones A, B, and C."},
  {q:"How does leak detection work?",a:"Four pressure sensors sit along the pipeline. The system watches the pressure drop between each pair. When a drop passes the safe limit, the zone between those two sensors is flagged as leaking. Two flow sensors then confirm it by comparing the water that entered the line against the water that came out."},
  {q:"Why verify email and phone?",a:"Verification confirms that the operator contact details are real and reachable. Email is checked first. Phone is checked second."},
  {q:"What happens when a leak is detected?",a:"The affected zone turns into an alert state, an incident is logged, the next technician on the rotation is assigned, and a fault report is prepared for the response team."},
  {q:"Who actually goes out and fixes the leak?",a:"The operator watching the dashboard and the technician fixing the pipe are two different people. The system keeps a standing maintenance team, and each new job goes to whoever has gone longest without one, so the work is shared evenly. The operator can hand a job to someone else if there is a good reason to."},
  {q:"Can I report a leak if I am not an operator?",a:"Yes. Use the Report a Leak button at the top of this page. You will get a reference number, and the report appears on the control room screen straight away. You can also email info@ujaqualogic.co.za."},
  {q:"What happens to my personal details?",a:"Your name and phone number are used only to follow up on the leak you reported and to let you know when it is fixed. Nothing else is collected."}
];

// ============================================================
// TOASTS AND SMALL HELPERS
// ============================================================
function showToast(title, msg, timeout = 4200){
  const pile = $('toastPile');
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<div style="font-size:20px">💧</div><div><div class="toast-title">${title}</div><div class="toast-msg">${msg}</div></div>`;
  pile.appendChild(t);
  setTimeout(() => {
    t.style.opacity = 0;
    t.style.transform = 'translateX(18px)';
    setTimeout(() => t.remove(), 400);
  }, timeout);
}
function normalizePhoneNumber(phone){
  if(!phone) return '';
  let p = phone.trim().replace(/\s+/g,'');
  if(p.startsWith('0')) p = '+27' + p.slice(1);
  if(!p.startsWith('+')) p = '+' + p;
  return p;
}
function setupRecaptcha(){
  const container = $('recaptcha-container');
  if(!container) return null;
  if(recaptchaVerifier){
    return recaptchaVerifier;
  }
  recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
    size: 'normal',
    callback: function () {
      console.log('reCAPTCHA solved');
    },
    'expired-callback': function () {
      showToast('⚠ Session expired', 'Please try phone verification again');
    }
  });
  return recaptchaVerifier;
}

// ============================================================
// PAGE DECORATION AND FAQ
// ============================================================
(function makeBubbles(){
  const bw = $('bubWrap');
  if(!bw) return;
  for(let i=0;i<20;i++){
    const b = document.createElement('div');
    b.className = 'bbl';
    const sz = Math.random()*16+6;
    const left = Math.random()*98;
    const dur = Math.random()*10+10;
    const del = Math.random()*-20;
    b.style.cssText = `width:${sz}px;height:${sz}px;left:${left}%;bottom:-${sz}px;animation-duration:${dur}s;animation-delay:${del}s;`;
    bw.appendChild(b);
  }
})();
$('faqList').innerHTML = FAQS.map((f,i)=>`
  <div class="faq-item">
    <button class="faq-q" id="fq-${i}" onclick="toggleFaq(${i})">
      <span>${f.q}</span><span class="chev">▾</span>
    </button>
    <div class="faq-a" id="fa-${i}">${f.a}</div>
  </div>
`).join('');
function toggleFaq(i){
  const el = $('fa-'+i);
  const btn = $('fq-'+i);
  const open = el.classList.contains('open');
  document.querySelectorAll('.faq-a').forEach(e => e.classList.remove('open'));
  document.querySelectorAll('.faq-q').forEach(e => e.classList.remove('open'));
  if(!open){
    el.classList.add('open');
    btn.classList.add('open');
  }
}

// Small helper so any button can show a spinner while it waits
// on Firebase or EmailJS, instead of looking frozen.
function setBtnLoading(btn, loading, busyText){
  if(!btn) return;
  if(loading){
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span>${busyText || 'Working...'}`;
  } else {
    btn.disabled = false;
    if(btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

// ============================================================
// PASSWORD STRENGTH
// ============================================================
function getStrength(pw){
  const met = PW_RULES.filter(r=>r.test(pw)).length;
  if(pw.length === 0) return 0;
  if(met <= 2) return 1;
  if(met === 3) return 2;
  if(met === 4 || met === 5) return 3;
  return 4;
}
function updatePwFeedback(pw, barId, labelId, reqsId){
  const s = getStrength(pw);
  const bar = $(barId);
  const lbl = $(labelId);
  const reqs = document.querySelectorAll(`#${reqsId} .pw-req`);
  if(bar){
    const spans = bar.querySelectorAll('span');
    spans.forEach((sp,i)=>{ sp.className = (i < s) ? `s${s}` : ''; });
  }
  const labels = ['','Weak','Fair','Good','Strong'];
  if(lbl){
    lbl.textContent = pw.length ? labels[s] : '';
    lbl.className = `pw-strength-label${pw.length ? ' s'+s : ''}`;
  }
  if(reqs.length){
    PW_RULES.forEach((rule,i)=>{
      if(reqs[i]) reqs[i].classList.toggle('met', rule.test(pw));
    });
  }
}
function toggleEye(inputId, btn){
  const inp = $(inputId);
  if(!inp) return;
  const isPass = inp.type === 'password';
  inp.type = isPass ? 'text' : 'password';
  btn.innerHTML = isPass
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

// ============================================================
// AUTH PANEL SCREENS
// ============================================================
function openAuth(mode='login'){
  APP.authStep = mode;
  renderAuth();
  $('authOverlay').classList.add('show');
  $('authOverlay').setAttribute('aria-hidden','false');
}
function closeAuth(){
  $('authOverlay').classList.remove('show');
  $('authOverlay').setAttribute('aria-hidden','true');
}
function renderAuth(){
  const c = $('authContent');
  const s = APP.authStep;
  if(s === 'login') c.innerHTML = loginHTML();
  else if(s === 'verifyLogin') c.innerHTML = verifyLoginHTML();
  else if(s === 'register') c.innerHTML = registerHTML();
  else if(s === 'verifyEmail') c.innerHTML = verifyEmailHTML();
  else if(s === 'verifyPhone') c.innerHTML = verifyPhoneHTML();
  else if(s === 'forgotEmail') c.innerHTML = forgotEmailHTML();
  else if(s === 'requestSent') c.innerHTML = requestSentHTML();
  const rc = $('recaptcha-container');
  if(rc){
    rc.style.display = (s === 'verifyPhone') ? 'block' : 'none';
    if(s !== 'verifyPhone') rc.innerHTML = '';
  }
  if(s === 'register') initRegisterForm();
  if(s === 'verifyEmail' || s === 'verifyPhone' || s === 'verifyLogin') setupOtpInputs();
  // Put the cursor where the person is going to type next.
  const first = c.querySelector('input');
  if(first) setTimeout(()=>first.focus(), 60);
}
// The eye icon is used on every password field, so it lives in
// one place instead of being pasted into each screen.
const EYE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
function otpBoxes(id){
  return `<div class="otp-row" id="${id}">
    ${Array(6).fill(0).map(()=>'<input maxlength="1" inputmode="numeric" autocomplete="one-time-code">').join('')}
  </div>`;
}
function loginHTML(){
  return `
    <div class="auth-screen">
      <div class="auth-h">Welcome back</div>
      <div class="auth-p">Sign in to open the water monitoring dashboard.</div>

      <div class="field">
        <input id="li-email" type="email" placeholder=" " autocomplete="email"/>
        <label for="li-email">Email address</label>
      </div>

      <div class="field pw-wrap">
        <input id="li-pass" type="password" placeholder=" " autocomplete="current-password"
               onkeydown="if(event.key==='Enter')startLoginOTP()"/>
        <label for="li-pass">Password</label>
        <button type="button" class="pw-toggle" onclick="toggleEye('li-pass',this)" aria-label="Show password">${EYE_SVG}</button>
      </div>

      <div style="text-align:right;margin-top:-8px">
        <button class="link-btn" onclick="showForgotPassword()">Forgot your password?</button>
      </div>

      <div class="auth-actions">
        <button class="btn btn-primary btn-block" id="loginBtn" onclick="startLoginOTP()">Sign In</button>
      </div>

      <div class="auth-alt">
        No account yet?
        <button class="link-btn" onclick="APP.authStep='register';renderAuth()">Register</button>
      </div>
    </div>
  `;
}
function verifyLoginHTML(){
  return `
    <div class="auth-screen">
      <div class="auth-h">Check your email</div>
      <div class="auth-p">
        We sent a six digit code to <span class="otp-target">${APP.pendingLogin?.email || 'your email'}</span>.
        Enter it below to finish signing in.
      </div>

      ${otpBoxes('otpLogin')}

      <div class="auth-actions">
        <button class="btn btn-primary btn-block" id="verifyLoginBtn" onclick="doLogin()">Verify and sign in</button>
        <button class="btn btn-ghost btn-block" onclick="resendLoginOtp()">Send the code again</button>
      </div>

      <div class="auth-alt">
        <button class="link-btn" onclick="APP.authStep='login';renderAuth()">Back to sign in</button>
      </div>
    </div>
  `;
}
function registerHTML(){
  return `
    <div class="auth-screen">
      <div class="auth-h">Request access</div>
      <div class="auth-p">
        Enter your details and confirm your email address. An administrator
        approves the account before you can sign in.
      </div>

      <div class="auth-row">
        <div class="field">
          <input id="rg-name" placeholder=" " autocomplete="given-name"/>
          <label for="rg-name">First name</label>
        </div>
        <div class="field">
          <input id="rg-surname" placeholder=" " autocomplete="family-name"/>
          <label for="rg-surname">Surname</label>
        </div>
      </div>

      <div class="field">
        <input id="rg-email" type="email" placeholder=" " autocomplete="email"/>
        <label for="rg-email">Email address</label>
      </div>

      <div class="field">
        <input id="rg-phone" type="tel" placeholder=" " autocomplete="tel"/>
        <label for="rg-phone">Phone number</label>
      </div>

      <div class="field">
        <label class="static-label" for="rg-role">I am applying as</label>
        <select id="rg-role" onchange="roleHint()">
          <option value="maintenance">Maintenance. I go out and fix the leaks</option>
          <option value="admin">Administrator. I run the control room</option>
        </select>
      </div>
      <div class="auth-note" id="roleHintBox" style="margin-top:-8px;margin-bottom:18px">
        ${ROLE_HINTS.maintenance}
      </div>

      <div class="field pw-wrap">
        <input id="rg-pass" type="password" placeholder=" "
               oninput="updatePwFeedback(this.value,'pwStrBar','pwStrLbl','pwReqsList');checkConfirm();"/>
        <label for="rg-pass">Password</label>
        <button type="button" class="pw-toggle" onclick="toggleEye('rg-pass',this)" aria-label="Show password">${EYE_SVG}</button>
      </div>
      <div class="pw-strength-bar" id="pwStrBar"><span></span><span></span><span></span><span></span></div>
      <div class="pw-strength-label" id="pwStrLbl"></div>
      <div class="pw-reqs" id="pwReqsList">
        ${PW_RULES.map(r=>`<div class="pw-req"><div class="req-dot">✓</div><span>${r.label}</span></div>`).join('')}
      </div>

      <div class="field pw-wrap" style="margin-top:18px">
        <input id="rg-conf" type="password" placeholder=" " oninput="checkConfirm()"/>
        <label for="rg-conf">Confirm password</label>
        <button type="button" class="pw-toggle" onclick="toggleEye('rg-conf',this)" aria-label="Show password">${EYE_SVG}</button>
      </div>
      <div id="matchMsg" style="font-size:.78rem;margin-top:-10px;height:16px;font-weight:700"></div>

      <div class="auth-note" style="margin-bottom:14px">
        What you pick above is a request. The administrator decides the role
        when they approve you.
      </div>

      <div class="auth-actions">
        <button class="btn btn-primary btn-block" id="registerBtn" onclick="doRegister()">Continue</button>
      </div>

      <div class="auth-alt">
        Already registered?
        <button class="link-btn" onclick="APP.authStep='login';renderAuth()">Sign in</button>
      </div>
    </div>`;
}
function verifyEmailHTML(){
  return `
    <div class="auth-screen">
      <div class="auth-h">Confirm your email</div>
      <div class="auth-p">
        We sent a six digit code to <span class="otp-target">${APP.pendingReg?.email || 'your email'}</span>.
      </div>

      ${otpBoxes('otpEmail')}

      <div class="auth-actions">
        <button class="btn btn-primary btn-block" id="verifyEmailBtn" onclick="verifyEmail()">Verify email</button>
        <button class="btn btn-ghost btn-block" onclick="resendOtp('email')">Send the code again</button>
      </div>

      <div class="auth-alt">
        <button class="link-btn" onclick="APP.authStep='register';renderAuth()">Back</button>
      </div>
    </div>`;
}
function verifyPhoneHTML(){
  return `
    <div class="auth-screen">
      <div class="auth-h">Confirm your phone</div>
      <div class="auth-p">
        An SMS code will be sent to <span class="otp-target">${APP.pendingReg?.phone || 'your number'}</span>.
      </div>

      <div class="auth-note">Complete the reCAPTCHA below, then enter the six digit code from the SMS.</div>

      ${otpBoxes('otpSms')}

      <div class="auth-actions">
        <button class="btn btn-ghost btn-block" onclick="sendPhoneOtp()">Send SMS code</button>
        <button class="btn btn-primary btn-block" onclick="verifyPhone()">Verify phone</button>
      </div>
    </div>`;
}
function forgotEmailHTML(){
  return `
    <div class="auth-screen">
      <div class="auth-h">Reset your password</div>
      <div class="auth-p">Enter your registered email. Firebase sends a reset link that works on any device.</div>

      <div class="field">
        <input id="fp-email" type="email" placeholder=" " autocomplete="email"/>
        <label for="fp-email">Email address</label>
      </div>

      <div class="auth-actions">
        <button class="btn btn-primary btn-block" id="resetBtn" onclick="sendResetOTP()">Send reset link</button>
      </div>

      <div class="auth-alt">
        <button class="link-btn" onclick="APP.authStep='login';renderAuth()">Back to sign in</button>
      </div>
    </div>
  `;
}
// Shown once the account has been created as a request. It is
// deliberately a full screen and not a toast, because the person
// needs to understand that they cannot sign in yet.
function requestSentHTML(){
  return `
    <div class="auth-screen">
      <div class="request-sent-icon" aria-hidden="true">✓</div>
      <div class="auth-h">Your request has been sent</div>
      <div class="auth-p">
        Your email address is confirmed and your account has been created,
        but it is not active yet.
      </div>

      <div class="request-sent-steps">
        <div class="rs-step done"><span>1</span> Email confirmed</div>
        <div class="rs-step done"><span>2</span> Account created</div>
        <div class="rs-step waiting"><span>3</span> Waiting for an administrator to approve you</div>
      </div>

      <div class="auth-note" style="margin-top:18px">
        An administrator reviews every request and decides whether the account
        is an administrator or a maintenance technician. You will be able to
        sign in as soon as that is done. If it is taking long, email
        <a href="mailto:info@ujaqualogic.co.za">info@ujaqualogic.co.za</a>.
      </div>

      <div class="auth-actions">
        <button class="btn btn-primary btn-block" onclick="APP.authStep='login';renderAuth()">Back to sign in</button>
      </div>
    </div>
  `;
}
function initRegisterForm(){}
function checkConfirm(){
  const pw = ($('rg-pass')||{}).value || '';
  const cf = ($('rg-conf')||{}).value || '';
  const msg = $('matchMsg');
  if(!msg) return;
  if(cf.length === 0){
    msg.textContent = '';
    return;
  }
  if(pw === cf){
    msg.textContent = '✓ Passwords match';
    msg.style.color = '#00e5a0';
  } else {
    msg.textContent = '✗ Passwords do not match';
    msg.style.color = '#ff6b5e';
  }
}
function setupOtpInputs(){
  const inputs = document.querySelectorAll('.auth-shell input[maxlength="1"]');
  inputs.forEach((inp,i)=>{
    inp.addEventListener('input',()=>{
      inp.value = inp.value.replace(/\D/g,'');
      if(inp.value && inputs[i+1]) inputs[i+1].focus();
    });
    inp.addEventListener('keydown',e=>{
      if(e.key === 'Backspace' && !inp.value && inputs[i-1]) inputs[i-1].focus();
    });
    // Pasting the whole code into the first box fills them all,
    // which is what most people try to do.
    inp.addEventListener('paste',e=>{
      const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g,'');
      if(!text) return;
      e.preventDefault();
      text.split('').slice(0, inputs.length - i).forEach((ch,n)=>{
        if(inputs[i+n]) inputs[i+n].value = ch;
      });
      const last = Math.min(i + text.length, inputs.length - 1);
      inputs[last].focus();
    });
  });
}
function getOTP(selector){
  return Array.from(document.querySelectorAll(selector+' input')).map(i=>i.value).join('');
}
function genOTP(){
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ============================================================
// REGISTRATION
// ============================================================
function doRegister(){
  const name = ($('rg-name')||{}).value?.trim() || '';
  const surname = ($('rg-surname')||{}).value?.trim() || '';
  const email = (($('rg-email')||{}).value?.trim() || '').toLowerCase();
  const phoneRaw = ($('rg-phone')||{}).value?.trim() || '';
  const phone = normalizePhoneNumber(phoneRaw);
  const pass = ($('rg-pass')||{}).value || '';
  const conf = ($('rg-conf')||{}).value || '';
  // What the person is applying for. An administrator decides
  // the real role at approval time, so this is only a request.
  const requestedRole = ($('rg-role')||{}).value || 'maintenance';
  if(!name || !surname || !email || !phone || !pass || !conf){
    showToast('⚠ Missing fields', 'Please complete all fields');
    return;
  }
  if(pass.length < 8){
    showToast('⚠ Weak password', 'Password must be at least 8 characters');
    return;
  }
  if(getStrength(pass) < 3){
    showToast('⚠ Weak password', 'Please meet more password requirements');
    return;
  }
  if(pass !== conf){
    showToast('⚠ Password mismatch', 'Passwords do not match');
    return;
  }
  APP.pendingReg = { name, surname, email, phone, pass, requestedRole };
  APP.emailOTP = genOTP();
  const btn = $('registerBtn');
  setBtnLoading(btn, true, 'Sending code...');
  emailjs.send(MAIL.service, MAIL.otp,{
    email: APP.pendingReg.email,
    otp_code: APP.emailOTP
  })
  .then(()=>{
    APP.authStep = 'verifyEmail';
    renderAuth();
    showToast('📧 Email OTP sent', 'Check your email for the code');
  })
  .catch((err)=>{
    console.error(err);
    setBtnLoading(btn, false);
    showToast('❌ Email send failed', 'Check your EmailJS service and template settings');
  });
}
function resendOtp(type){
  if(!APP.pendingReg){
    showToast('⚠ No registration session', 'Please register again');
    return;
  }
  if(type === 'email'){
    APP.emailOTP = genOTP();
    emailjs.send(MAIL.service, MAIL.otp,{
      email: APP.pendingReg.email,
      otp_code: APP.emailOTP
    })
    .then(()=>showToast('📧 Email OTP resent', 'Check your inbox'))
    .catch((err)=>{
      console.error(err);
      showToast('❌ Email resend failed', 'Please try again');
    });
  }
}
// The account is created in Firebase Authentication once the
// email OTP is confirmed. Nothing is stored in the browser, so
// the same login works on any phone or laptop.
function verifyEmail(){
  const code = getOTP('#otpEmail');
  if(code.length < 6){
    showToast('⚠ Incomplete code', 'Enter the full 6 digit email code');
    return;
  }
  if(code !== APP.emailOTP){
    showToast('❌ Wrong email code', 'The email OTP does not match');
    return;
  }
  const u = APP.pendingReg;
  if(!u){
    showToast('⚠ Session expired', 'Please register again');
    APP.authStep = 'register';
    renderAuth();
    return;
  }
  auth.createUserWithEmailAndPassword(u.email, u.pass)
    .then(cred => {
      // Profile details go in the database. The password does not.
      //
      // Note what is missing here. No role and no approval. The
      // account is written as a request and nothing more, so
      // creating it grants no access to anything. An
      // administrator decides the role later, and until they do
      // the sign in screen will not let this account through.
      const uid = cred.user.uid;
      return rtdb.ref('users/' + uid).set({
        name: u.name,
        surname: u.surname,
        email: u.email.toLowerCase(),
        phone: u.phone,
        requestedRole: u.requestedRole || 'maintenance',
        status: STATUS.PENDING,
        createdAt: Date.now()
      });
    })
    .then(() => auth.signOut())
    .then(() => {
      APP.pendingReg = null;
      APP.authStep = 'requestSent';
      renderAuth();
      showToast('✅ Request sent', 'An administrator will review your access request');
    })
    .catch(err => {
      console.error(err);
      if(err.code === 'auth/email-already-in-use'){
        showToast('⚠ Already registered', 'This email already has an account. Please sign in.');
        APP.authStep = 'login';
        renderAuth();
      } else if(err.code === 'auth/weak-password'){
        showToast('⚠ Weak password', 'Firebase needs at least 6 characters');
      } else {
        showToast('❌ Registration failed', err.message || 'Please try again');
      }
    });
}
function sendPhoneOtp(){
  if(!APP.pendingReg?.phone){
    showToast('⚠ Missing phone number', 'Phone number not found');
    return;
  }
  const phoneNumber = normalizePhoneNumber(APP.pendingReg.phone);
  const verifier = setupRecaptcha();
  auth.signInWithPhoneNumber(phoneNumber, verifier)
    .then(function(result){
      confirmationResult = result;
      showToast('📲 SMS OTP sent', 'Check your phone for the code');
    })
    .catch(function(error){
      console.error(error);
      showToast('❌ SMS send failed', 'Check Firebase Phone Auth, domain, and number format');
    });
}
function verifyPhone(){
  const code = getOTP('#otpSms');
  if(code.length < 6){
    showToast('⚠ Incomplete code', 'Enter the full 6 digit SMS code');
    return;
  }
  if(!confirmationResult){
    showToast('⚠ No SMS session', 'Press Send SMS Code first');
    return;
  }
  confirmationResult.confirm(code)
    .then(() => auth.signOut())
    .then(() => {
      confirmationResult = null;
      showToast('✅ Phone verified', 'Please sign in with your email and password');
      APP.authStep = 'login';
      renderAuth();
    })
    .catch(err => {
      console.error(err);
      showToast('❌ Wrong SMS code', 'The code does not match');
    });
}

// ============================================================
// SIGN IN
// ============================================================
// The password was already checked by Firebase in startLoginOTP,
// so this step only has to confirm the emailed OTP.
function doLogin(){
  const otp = getOTP('#otpLogin');
  if(otp.length < 6){
    showToast('⚠ Incomplete code', 'Enter the full six digit code from your email');
    return;
  }
  if(!APP.pendingLogin){
    showToast('⚠ Session expired', 'Please sign in again');
    return;
  }
  if(otp !== APP.emailOTP){
    showToast('❌ Wrong OTP', 'Incorrect verification code');
    return;
  }
  APP.user = APP.pendingLogin;
  APP.pendingLogin = null;
  closeAuth();
  launchDashboard();
  showToast('✅ Login successful', `Welcome, ${APP.user.name}`);
}
// Same email, fresh code, for when the first one does not arrive.
function resendLoginOtp(){
  const email = APP.pendingLogin?.email;
  if(!email){
    showToast('⚠ Session expired', 'Please sign in again');
    return;
  }
  APP.emailOTP = genOTP();
  emailjs.send(MAIL.service, MAIL.otp,{ email: email, otp_code: APP.emailOTP })
    .then(()=>showToast('📧 Code resent', 'Check your inbox'))
    .catch(err=>{
      console.error(err);
      showToast('❌ Could not resend', 'Please try again');
    });
}
function showForgotPassword(){
  APP.authStep = 'forgotEmail';
  renderAuth();
}
function sendResetOTP(){
  const email = ($('fp-email')||{}).value?.trim().toLowerCase();
  if(!email){
    showToast('⚠ Missing Email', 'Enter your email');
    return;
  }
  const btn = $('resetBtn');
  setBtnLoading(btn, true, 'Sending link...');
  auth.sendPasswordResetEmail(email)
    .then(() => {
      showToast('📧 Reset link sent', 'Check your email and follow the link');
      APP.authStep = 'login';
      renderAuth();
    })
    .catch(err => {
      console.error(err);
      setBtnLoading(btn, false);
      if(err.code === 'auth/user-not-found'){
        showToast('❌ Email Not Found', 'This email is not registered');
      } else {
        showToast('❌ Could not send', 'Check the email address and try again');
      }
    });
}
// Credentials are checked by Firebase, not by the browser, so
// an account made on one device works on every device.
function startLoginOTP(){
  const email = ($('li-email')||{}).value?.trim().toLowerCase();
  const pass  = ($('li-pass')||{}).value;
  if(!email || !pass){
    showToast('⚠ Missing details', 'Enter email and password first');
    return;
  }
  const btn = $('loginBtn');
  setBtnLoading(btn, true, 'Checking...');
  let uid = null;
  auth.signInWithEmailAndPassword(email, pass)
    .then(cred => { uid = cred.user.uid; return rtdb.ref('users/' + uid).get(); })
    .then(snap => {
      const profile = snap.val();

      // The password was right, but that only proves who they
      // are. Whether they are allowed in is a separate question,
      // and the answer lives in the database.
      if(!profile){
        return Promise.reject({ aqua: ['⚠ Profile missing', 'This account has no profile on record. Please register again or contact the administrator.'] });
      }
      if(profile.status !== STATUS.APPROVED){
        const msg = STATUS_MESSAGE[profile.status] || STATUS_MESSAGE[STATUS.PENDING];
        return Promise.reject({ aqua: msg });
      }

      APP.pendingLogin = Object.assign(
        { name:'Operator', surname:'', email:email, phone:'' },
        profile,
        { uid: uid, role: profile.role || 'maintenance' }
      );
      APP.emailOTP = genOTP();
      return emailjs.send(MAIL.service, MAIL.otp,{
        email: email,
        otp_code: APP.emailOTP
      });
    })
    .then(() => {
      // The password was right, so the panel moves on to the
      // code screen instead of growing a second section.
      APP.authStep = 'verifyLogin';
      renderAuth();
      showToast('📧 OTP sent', 'Check your email');
    })
    .catch(err => {
      setBtnLoading(btn, false);

      // A rejection carrying an 'aqua' message means the password
      // was correct but the account is not allowed in. Firebase
      // has already signed them in at this point, so sign them
      // straight back out before showing the reason.
      if(err && err.aqua){
        auth.signOut().catch(e => console.error(e));
        APP.pendingLogin = null;
        showToast(err.aqua[0], err.aqua[1], 7000);
        return;
      }

      console.error(err);
      switch(err.code){
        case 'auth/user-not-found':
          showToast('❌ Account not found', 'Please register first');
          break;
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
        case 'auth/invalid-login-credentials':
          showToast('❌ Invalid credentials', 'Incorrect email or password');
          break;
        case 'auth/invalid-email':
          showToast('⚠ Invalid email', 'Check the email address');
          break;
        case 'auth/too-many-requests':
          showToast('⚠ Too many attempts', 'Wait a moment and try again');
          break;
        case 'auth/network-request-failed':
          showToast('❌ No connection', 'Check your internet and try again');
          break;
        default:
          showToast('❌ Sign in failed', err.message || 'Please try again');
      }
    });
}

// ============================================================
// DASHBOARD OPEN AND CLOSE
// ============================================================
function launchDashboard(){
  $('publicSite').style.display = 'none';
  $('dashboard').style.display = 'block';
  $('dashboard').setAttribute('aria-hidden','false');
  $('dashUserName').textContent = APP.user?.name || 'Operator';
  $('dashWelcome').textContent = `Welcome , ${APP.user?.name || 'Operator'} 👋`;
  // The role sits next to the name so it is always obvious which
  // kind of account is looking at the screen.
  const chip = $('roleChip');
  if(chip){
    chip.textContent = isAdmin() ? 'Administrator' : 'Maintenance';
    chip.className = 'role-chip ' + (isAdmin() ? 'admin' : 'tech');
  }
  // Screens that only an administrator should see. A technician
  // opens the same dashboard, they just do not get the panel
  // that hands out access.
  const adminOnly = document.querySelectorAll('[data-admin-only]');
  adminOnly.forEach(el => { el.style.display = isAdmin() ? '' : 'none'; });

  updateTime();
  startIncidentLog();
  renderPressure(null);
  renderFlow(null);
  renderZones({});
  startLiveData();
  startTeam();
  startReports();
  startAccessRequests();
  renderDispatch();
}
function logout(){
  auth.signOut().catch(err => console.error(err));
  APP.user = null;
  APP.pendingLogin = null;
  APP.incidentLog = [];
  APP.leakZones = [];
  APP.forcedLeakZone = null;
  APP.forcedLeakUntil = 0;
  APP.liveData = null;
  $('dashboard').style.display = 'none';
  $('publicSite').style.display = 'block';
  $('dashboard').setAttribute('aria-hidden','true');
  stopLiveData();
  stopIncidentLog();
  stopReports();
  stopTeam();
  stopAccessRequests();
  showToast('👋 Logged out', 'You have been signed out');
}
function updateTime(){
  $('dashTime').textContent = 'Last refreshed: ' + new Date().toLocaleString('en-ZA',{dateStyle:'medium',timeStyle:'short'});
}

// ============================================================
// REAL TIME DATA
// The ESP32 writes readings to /aqualogic in the Realtime
// Database roughly every second. This listener fires on every
// write, so the dashboard updates live with no polling.
// ============================================================
let liveRef = null;
function startLiveData(){
  if(APP.liveListenerActive) return;
  liveRef = rtdb.ref('/aqualogic');
  liveRef.on('value', (snapshot) => {
    const data = snapshot.val();
    updateTime();
    if(!data){
      APP.deviceOnline = false;
      setSystemStatus('amber', 'WAITING FOR DEVICE');
      return;
    }
    APP.liveData = data;
    APP.deviceOnline = true;
    applyLiveData(data);
  }, (err) => {
    console.error('Firebase read failed', err);
    APP.deviceOnline = false;
    setSystemStatus('amber', 'DATABASE ERROR - CHECK CONFIG');
  });
  APP.liveListenerActive = true;
}
function stopLiveData(){
  if(liveRef) liveRef.off();
  APP.liveListenerActive = false;
}
function applyLiveData(data){
  const lvl = Math.round(data.tank?.level ?? 0);
  setEl('levelVal', lvl);
  animateWidth('levelBar', lvl);
  $('tankWater').style.height = lvl + '%';
  $('tankPctLbl').textContent = lvl + '%';
  updateLevelStatus(lvl);
  renderPressure(data);
  renderFlow(data);
  renderZones(data);
}
// Mirrors the physical LED level indicator on the device:
// green at 70% or more, yellow from 30% to 69%, red below 30%.
function updateLevelStatus(lvl){
  const st = $('levelStatus');
  const bar = $('levelBar');
  const water = $('tankWater');
  if(!st) return;
  if(lvl >= 70){
    st.textContent = '● LEVEL GOOD';
    st.style.background = 'rgba(0,201,122,.15)';
    st.style.color = '#00e5a0';
    st.style.borderColor = '#00c97a';
    if(bar) bar.style.background = 'linear-gradient(90deg,#00915f,#00e5a0)';
    if(water) water.style.background = 'linear-gradient(180deg,#00e5a0,#00915f)';
  }
  else if(lvl >= 30){
    st.textContent = '● LEVEL MODERATE';
    st.style.background = 'rgba(255,179,0,.15)';
    st.style.color = '#ffb300';
    st.style.borderColor = '#ffb300';
    if(bar) bar.style.background = 'linear-gradient(90deg,#c98a00,#ffb300)';
    if(water) water.style.background = 'linear-gradient(180deg,#ffb300,#c98a00)';
  }
  else {
    st.textContent = '● LEVEL LOW - REFILL';
    st.style.background = 'rgba(244,67,54,.15)';
    st.style.color = '#ff6b5e';
    st.style.borderColor = '#f44336';
    if(bar) bar.style.background = 'linear-gradient(90deg,#b71c1c,#f44336)';
    if(water) water.style.background = 'linear-gradient(180deg,#f44336,#b71c1c)';
  }
}
function setSystemStatus(color, text){
  $('sysStatusDot').className = 'status-dot ' + color;
  $('sysStatusTxt').textContent = text;
}
function refreshDash(){
  showToast('🔄 Refreshing', 'Reading live sensor data');
  rtdb.ref('/aqualogic').get().then((snap) => {
    const data = snap.val();
    if(data){
      APP.liveData = data;
      APP.deviceOnline = true;
      applyLiveData(data);
    }
    updateTime();
    showToast('✅ Updated', 'Sensor data refreshed');
  }).catch((err) => {
    console.error(err);
    showToast('❌ Refresh failed', 'Could not reach the database');
  });
}

// ============================================================
// PIPELINE PRESSURE
// Draws the four sensor points sent by the ESP32.
// ============================================================
function pressureColour(raw){
  if(raw < PRESSURE_RAW_MAX * 0.30){
    return { bar:'linear-gradient(90deg,#b71c1c,#f44336)', text:'#ff6b5e' };
  }
  if(raw < PRESSURE_RAW_MAX * 0.60){
    return { bar:'linear-gradient(90deg,#c98a00,#ffb300)', text:'#ffb300' };
  }
  return { bar:'linear-gradient(90deg,#00915f,#00e5a0)', text:'#ffffff' };
}
function renderPressure(data){
  const grid = $('pressureGrid');
  if(!grid) return;
  const p = data?.pressure || {};
  const readings = [];
  grid.innerHTML = PRESSURE_POINTS.map(pt => {
    const raw = p[pt.key];
    const has = raw !== undefined && raw !== null && !isNaN(Number(raw));
    const val = has ? Number(raw) : 0;
    if(has) readings.push(val);
    const pct = has ? Math.min(100, Math.max(0, (val / PRESSURE_RAW_MAX) * 100)) : 0;
    const c = has ? pressureColour(val)
                  : { bar:'#1e4060', text:'rgba(255,255,255,.35)' };
    return `
      <div class="p-point">
        <div class="p-tag">${pt.tag}</div>
        <div class="p-name">${pt.name}</div>
        <div class="p-val" style="color:${c.text}">
          ${has ? barText(val) : '—'}<span class="p-unit">${PRESSURE_UNIT}</span>
        </div>
        <div class="p-bar-bg">
          <div class="p-bar-fill" style="width:${pct}%;background:${c.bar}"></div>
        </div>
      </div>`;
  }).join('');
  const sum = $('pressureSummary');
  if(sum){
    if(readings.length === PRESSURE_POINTS.length){
      const drop = (readings[0] - readings[readings.length - 1]) / PRESSURE_DIVISOR;
      sum.textContent = `Inlet to outlet drop: ${drop.toFixed(PRESSURE_DECIMALS)} ${PRESSURE_UNIT}`;
    } else {
      sum.textContent = 'Waiting for sensor data';
    }
  }
}

// ============================================================
// WATER FLOW
// Reads /aqualogic/flow/in and /aqualogic/flow/out, both in
// litres per minute. The third tile is the gap between them.
// Water entering faster than it leaves means it is escaping
// somewhere along the line.
// ============================================================
function renderFlow(data){
  const grid = $('flowGrid');
  if(!grid) return;
  const f      = data?.flow || {};
  const rawIn  = f.in;
  const rawOut = f.out;
  const hasIn  = rawIn  !== undefined && rawIn  !== null && !isNaN(Number(rawIn));
  const hasOut = rawOut !== undefined && rawOut !== null && !isNaN(Number(rawOut));
  const hasBoth = hasIn && hasOut;
  const vIn  = hasIn  ? Number(rawIn)  / FLOW_DIVISOR : 0;
  const vOut = hasOut ? Number(rawOut) / FLOW_DIVISOR : 0;
  const gap  = hasBoth ? (vIn - vOut) : 0;
  const gapHigh = hasBoth && Math.abs(gap) >= FLOW_LOSS_LIMIT;
  // F1 and F2 bars are shown against the full sensor range.
  // The gap bar fills as it climbs toward the leak threshold.
  const inPct  = hasIn  ? Math.min(100, Math.max(0, (vIn  / FLOW_MAX) * 100)) : 0;
  const outPct = hasOut ? Math.min(100, Math.max(0, (vOut / FLOW_MAX) * 100)) : 0;
  const gapPct = hasBoth ? Math.min(100, Math.max(0, (Math.abs(gap) / FLOW_LOSS_LIMIT) * 100)) : 0;
  const green = 'linear-gradient(90deg,#00915f,#00e5a0)';
  const red   = 'linear-gradient(90deg,#b71c1c,#f44336)';
  const idle  = '#1e4060';
  const dim   = 'rgba(255,255,255,.35)';
  grid.innerHTML = `
    <div class="p-point">
      <div class="p-tag">F1</div>
      <div class="p-name">Flow In. Reservoir Outlet</div>
      <div class="p-val" style="color:${hasIn ? '#ffffff' : dim}">
        ${hasIn ? vIn.toFixed(FLOW_DECIMALS) : '—'}<span class="p-unit">${FLOW_UNIT}</span>
      </div>
      <div class="p-bar-bg">
        <div class="p-bar-fill" style="width:${inPct}%;background:${hasIn ? green : idle}"></div>
      </div>
    </div>
    <div class="p-point">
      <div class="p-tag">F2</div>
      <div class="p-name">Flow Out. Pipeline End</div>
      <div class="p-val" style="color:${hasOut ? '#ffffff' : dim}">
        ${hasOut ? vOut.toFixed(FLOW_DECIMALS) : '—'}<span class="p-unit">${FLOW_UNIT}</span>
      </div>
      <div class="p-bar-bg">
        <div class="p-bar-fill" style="width:${outPct}%;background:${hasOut ? green : idle}"></div>
      </div>
    </div>
    <div class="p-point" style="${gapHigh ? 'border-color:#d32f2f;background:#2a0a0a;' : ''}">
      <div class="p-tag">F1 − F2</div>
      <div class="p-name">Flow Imbalance</div>
      <div class="p-val" style="color:${!hasBoth ? dim : (gapHigh ? '#ff6b5e' : '#00e5a0')}">
        ${hasBoth ? gap.toFixed(FLOW_DECIMALS) : '—'}<span class="p-unit">${FLOW_UNIT}</span>
      </div>
      <div class="p-bar-bg">
        <div class="p-bar-fill" style="width:${gapPct}%;background:${gapHigh ? red : green}"></div>
      </div>
    </div>`;
  const sum = $('flowSummary');
  if(sum){
    if(hasBoth){
      const pct = vIn > 0 ? (vOut / vIn) * 100 : 0;
      sum.textContent = `Outflow is ${pct.toFixed(1)}% of inflow. Imbalance ${gap.toFixed(FLOW_DECIMALS)} ${FLOW_UNIT}, limit ${FLOW_LOSS_LIMIT} ${FLOW_UNIT}`;
      sum.style.color = gapHigh ? '#ff6b5e' : '#7dd8f0';
    } else {
      sum.textContent = 'Waiting for flow sensor data';
      sum.style.color = '#7dd8f0';
    }
  }
}

// ============================================================
// SENSOR ZONES
// ============================================================
function renderZones(data){
  const liveLeakDetected = !!(data?.leak?.detected);
  const liveLeakZoneNum = data?.leak?.zone || 0;
  APP.leakZones = [];
  let hasLeak = false;
  const grid = $('zonesGrid');
  grid.innerHTML = '';
  ZONES.forEach(z => {
    // A demo override (from the "Demo Leak" button) takes priority
    // so the UI can be tested before the hardware is connected.
    // It expires on its own, otherwise the demo zone would stay
    // lit over the top of the real sensor readings forever.
    const demoActive = APP.forcedLeakZone && Date.now() < APP.forcedLeakUntil;
    if(APP.forcedLeakZone && !demoActive) APP.forcedLeakZone = null;
    const forced = demoActive && APP.forcedLeakZone === z.id;
    const leak = forced || (liveLeakDetected && liveLeakZoneNum === z.num);
    const offline = !leak && !APP.deviceOnline;
    if(leak){
      APP.leakZones.push(z.id);
      hasLeak = true;
    }
    let sdot='normal', slbl='Sensor Active', ssub='Normal. Pressure within range';
    if(leak){
      sdot='leak';
      slbl='LEAK DETECTED';
      ssub='Unexpected flow or pressure drop';
    }
    if(offline){
      sdot='offline';
      slbl='Sensor Offline';
      ssub='No data from device yet';
    }
    // Pressure either side of this zone, taken straight from
    // the two sensors that bracket it.
    const seg  = ZONE_SEGMENTS[z.id] || [];
    const pIn  = Number(data?.pressure?.[seg[0]]);
    const pOut = Number(data?.pressure?.[seg[1]]);
    const hasP = !isNaN(pIn) && !isNaN(pOut);
    const dropRaw = hasP ? (pIn - pOut) : 0;
    const dropColour = !hasP ? '#8fc4e0'
                     : (dropRaw >= LEAK_DROP_RAW ? '#ff6b5e' : '#00e5a0');
    const pressureRow = `
      <div class="zone-pressure">
        <span class="zp-label">${(seg[0]||'').toUpperCase()} in / ${(seg[1]||'').toUpperCase()} out</span>
        <span class="zp-val">${hasP ? barText(pIn) + ' / ' + barText(pOut) + ' ' + PRESSURE_UNIT : '— / —'}</span>
      </div>
      <div class="zone-pressure" style="margin-bottom:12px">
        <span class="zp-label">Pressure drop</span>
        <span class="zp-val" style="color:${dropColour}">${hasP ? (dropRaw / PRESSURE_DIVISOR).toFixed(PRESSURE_DECIMALS) + ' ' + PRESSURE_UNIT : '—'}</span>
      </div>`;
    // What the public is saying about this same zone. A leak with
    // reports behind it is confirmed. A leak with silence behind
    // it is the buried one nobody can see.
    const zoneReports = openReportsInZone(z.id);
    let publicRow = '';
    if(leak && zoneReports.length){
      publicRow = `<div class="zone-corroboration">📣 <span><strong>${zoneReports.length} public report${zoneReports.length>1?'s':''}</strong> from this zone. Sensors and residents agree.</span></div>`;
    } else if(leak){
      publicRow = `<div class="zone-silent">🕳️ <span>No public reports. This one is underground where nobody can see it.</span></div>`;
    } else if(zoneReports.length){
      publicRow = `<div class="zone-corroboration">📣 <span>${zoneReports.length} public report${zoneReports.length>1?'s':''} here, but the sensors are steady. Worth checking.</span></div>`;
    }

    const card = document.createElement('div');
    card.className = 'zone-card' + (leak ? ' leak-zone' : '');
    card.innerHTML = `
      <div class="zone-id">Sensor Zone ${z.id}</div>
      <div class="zone-name-big">${z.name}</div>
      <div style="font-size:.78rem;color:#b0d8f0;margin-bottom:10px">${z.desc}</div>
      <div class="sensor-status">
        <div class="sensor-dot ${sdot}"></div>
        <div style="flex:1">
          <strong style="display:block">${slbl}</strong>
          <span style="font-size:.78rem;color:#cce8f8">${ssub}</span>
        </div>
      </div>
      ${pressureRow}
      ${publicRow}
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
        <div style="background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);padding:6px 10px;border-radius:999px;color:#fff;font-weight:700;font-size:.8rem">
          ${leak ? '⚠ LEAK DETECTED' : '✓ NORMAL'}
        </div>
        <div style="margin-left:auto;display:flex;gap:8px">
          <button class="ctrl" onclick="acknowledge('${z.id}')">Acknowledge</button>
          <button class="ctrl" onclick="silenceAlarm('${z.id}')">🔕 Silence my phone</button>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });
  if(hasLeak){
    setSystemStatus('red', `⚠ ${APP.leakZones.length} LEAK${APP.leakZones.length>1?'S':''} DETECTED`);
    // A zone is red, so the report panel is open. Always.
    // No waiting period, no conditions. It stays up for as long
    // as the leak is there, and it refreshes itself with the
    // latest readings on every update from the device.
    APP.lastEmailSentAt = 0;   // the report can always be sent
    openFaultModal();

    // The incident is only written to the history when the set of
    // red zones actually changes. Without this the device would
    // write a new history row four times a second for as long as
    // the leak lasted, and the log would be unusable.
    const key = APP.leakZones.join(',');
    if(key !== APP.lastAlertKey){
      APP.lastAlertKey = key;
      const t = new Date().toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit'});
      APP.leakZones.forEach(zid => logEvent('leak', `Zone ${zid}: Leak detected`, t, `Zone ${zid}`));

      // Note in the history whether the public had already
      // reported this. That comparison is the whole point of
      // running two sources side by side.
      APP.leakZones.forEach(zid => {
        const n = openReportsInZone(zid).length;
        if(n){
          logEvent('report', `Zone ${zid}: sensor leak matches ${n} public report${n>1?'s':''}. Confirmed.`, t, `Zone ${zid}`);
        }
      });

      // A leak with nobody assigned to it is only half an alert,
      // so the next technician on the rotation is called up here.
      autoAssignForLeak(key);
    }
  } else if(APP.deviceOnline){
    setSystemStatus('green', 'ALL SYSTEMS NOMINAL');
    // Pipeline is clear. Close the report panel and forget the
    // last alarm, so the very next leak raises a fresh one.
    closeFault();
    APP.lastAlertKey = null;
    APP.assignedForKey = null;
    APP.escalationsSent = {};
  }

  // Each report card carries a line saying whether the sensors
  // back it up, so those cards have to be redrawn whenever the
  // sensor picture changes. Only on a change, not every frame.
  const leakKey = APP.leakZones.join(',') + '|' + (sensorDataAvailable() ? 'on' : 'off');
  if(leakKey !== APP.lastLeakRenderKey){
    APP.lastLeakRenderKey = leakKey;
    renderReports();
  }
}

// ============================================================
// INCIDENT HISTORY
// Incidents are saved in Firebase under /incidents, so the list
// survives a refresh, a logout, and a change of device. Every
// operator sees the same history.
//
// Note on the path. This deliberately sits OUTSIDE /aqualogic.
// The ESP32 sends an HTTP PUT to /aqualogic.json about once a second,
// and a PUT replaces that whole node. Anything stored inside it
// would be erased on the next sensor push.
// ============================================================
let incidentRef = null;

// Opens a live listener on the stored history. It fires once
// straight away with everything already saved, then again each
// time a new incident is written, by this operator or any other.
function startIncidentLog(){
  if(incidentRef) return;
  incidentRef = rtdb.ref('/incidents').limitToLast(100);
  incidentRef.on('value', (snap) => {
    const rows = [];
    snap.forEach(child => { rows.push(child.val()); });
    // Firebase hands them back oldest first. The panel shows
    // newest at the top, so the order is flipped here.
    APP.incidentLog = rows.reverse();
    renderHistoryBody(APP.activeFilter || 'all');
  }, (err) => {
    console.error('Incident history read failed', err);
    showToast('⚠ History unavailable', 'Could not load past incidents');
  });
}
function stopIncidentLog(){
  if(incidentRef) incidentRef.off();
  incidentRef = null;
}
// Saves one incident. Nothing is added to the on screen list
// here on purpose. The listener above receives the new entry
// and redraws, which keeps every open dashboard in step.
function logEvent(type,msg,time,zone){
  rtdb.ref('/incidents').push({
    type:     type,
    msg:      msg,
    time:     time,
    zone:     zone || 'System',
    operator: APP.user?.name || 'System',
    ts:       Date.now()
  }).catch(err => {
    console.error('Could not save incident', err);
    showToast('⚠ Not saved', 'The incident could not be written to the database');
  });
}
function openHistory(){
  renderHistoryBody(APP.activeFilter || 'all');
  $('historyModal').classList.add('show');
  $('historyModal').setAttribute('aria-hidden','false');
}
function closeHistory(){
  $('historyModal').classList.remove('show');
  $('historyModal').setAttribute('aria-hidden','true');
}
function filterHistory(f){
  APP.activeFilter = f;
  renderHistoryBody(f);
}
function renderHistoryBody(filter){
  const icons={leak:'🔴',normal:'🟢',email:'📧',system:'⚙️',dispatch:'🔧',report:'📣'};
  const filtered = (!filter || filter==='all') ? APP.incidentLog : APP.incidentLog.filter(e=>e.type===filter);
  const body = $('historyBody');
  body.innerHTML = filtered.length
    ? filtered.map(e=>{
        // The history now spans several days, so the date is
        // shown as well. Older entries saved before this change
        // only have a time, so that is used as a fallback.
        const when = e.ts
          ? new Date(e.ts).toLocaleString('en-ZA',{dateStyle:'short',timeStyle:'short'})
          : (e.time || '');
        return `
      <div class="h-item">
        <div class="h-item-icon" style="background:${e.type==='leak'?'#ffecec':e.type==='normal'?'#f0fff4':'#f0fbff'}">${icons[e.type]||'ℹ️'}</div>
        <div>
          <div class="h-item-title">${e.msg}</div>
          <div class="h-item-meta"><span>🕐 ${when}</span><span>📍 ${e.zone||'System'}</span><span>👤 ${e.operator||'System'}</span></div>
        </div>
      </div>`;
      }).join('')
    : `<div style="text-align:center;padding:30px;color:#6a9ab8;font-size:.95rem">No ${filter} events found</div>`;
}

// ============================================================
// FAULT REPORT AND EMAIL
// ============================================================
// Builds the report once so the on screen preview and the
// emailed report always carry the same figures.
function buildFaultReport(){
  const u = APP.user || {};
  const zones = APP.leakZones.length
    ? APP.leakZones.map(z => `Zone ${z}`).join(', ')
    : 'None';
  // Flow figures go into the report as supporting evidence.
  const fIn  = Number(APP.liveData?.flow?.in);
  const fOut = Number(APP.liveData?.flow?.out);
  const hasFlow = !isNaN(fIn) && !isNaN(fOut);
  const flowLine = hasFlow
    ? `Flow in ${(fIn / FLOW_DIVISOR).toFixed(FLOW_DECIMALS)} ${FLOW_UNIT}, flow out ${(fOut / FLOW_DIVISOR).toFixed(FLOW_DECIMALS)} ${FLOW_UNIT}, imbalance ${((fIn - fOut) / FLOW_DIVISOR).toFixed(FLOW_DECIMALS)} ${FLOW_UNIT}`
    : 'Flow sensor data not available';
  // Who is going out. Without this the report says a leak exists
  // but not who is dealing with it, which was the whole gap.
  const d = APP.dispatch;
  const assignedLine = d
    ? `${d.techName} (${d.techRole || 'Technician'}), contact ${d.techPhone || 'no number saved'}`
    : 'Not yet assigned';

  return {
    zones: zones,
    datetime: new Date().toLocaleString('en-ZA', { dateStyle:'full', timeStyle:'short' }),
    operator: `${u.name || 'System'} ${u.surname || ''}`.trim(),
    contact: u.phone || 'Not provided',
    operator_email: u.email || 'system@aqualogic.co.za',
    assigned: assignedLine,
    flow: flowLine,
    details: APP.leakZones.length
      ? APP.leakZones.map(z => {
          const seg  = ZONE_SEGMENTS[z] || [];
          const pIn  = Number(APP.liveData?.pressure?.[seg[0]]);
          const pOut = Number(APP.liveData?.pressure?.[seg[1]]);
          if(isNaN(pIn) || isNaN(pOut)){
            return `Zone ${z}: pressure drop or unexpected flow detected`;
          }
          const drop = (pIn - pOut) / PRESSURE_DIVISOR;
          return `Zone ${z}: pressure fell from ${barText(pIn)} ${PRESSURE_UNIT} to ${barText(pOut)} ${PRESSURE_UNIT}, a drop of ${drop.toFixed(PRESSURE_DECIMALS)} ${PRESSURE_UNIT}`;
        }).join('\n')
      : 'No zone data available'
  };
}
// Who a fault report goes to. Built from the live database, not
// from a list typed into this file.
//
//   The control room address, always. It is the one inbox that
//   is watched whether or not anybody is signed in.
//   Every technician currently on the rotation.
//   Every approved administrator, when the signed in account is
//   allowed to read the account list. A technician is not, so
//   for them the control room address covers it.
function faultRecipients(){
  const list = [CONTROL_ROOM_EMAIL];

  APP.team
    .filter(t => t.active !== false && t.email)
    .forEach(t => list.push(t.email));

  APP.accessRequests
    .filter(u => u.status === STATUS.APPROVED && u.role === 'admin' && u.email)
    .forEach(u => list.push(u.email));

  // One address might appear twice, for example a technician who
  // is also on the account list. Send to each person once.
  return Array.from(new Set(list.map(e => String(e).trim().toLowerCase()).filter(Boolean)));
}
function openFaultModal(){
  const r = buildFaultReport();
  APP.faultReport = r;
  const to = faultRecipients();
  $('faultEmailBody').textContent =
`To          : ${to.join(', ')}
From        : ${r.operator_email}
Subject     : [URGENT] Water Leak Detected. ${r.zones}
INCIDENT REPORT
Date and time : ${r.datetime}
Affected zones: ${r.zones}
Alert level   : High priority
Operator      : ${r.operator}
Contact       : ${r.contact}
ASSIGNED TO
${r.assigned}
ANOMALY DETAILS
${r.details}
WATER BALANCE
${r.flow}
Please dispatch a response team to the affected zone as soon as possible.
Aqua Logic Monitoring System`;
  // The email tells the whole team. This row is for reaching the
  // one person who is actually going out, without leaving the
  // alarm to go and look up their number.
  const row = $('faultDispatchRow');
  const d = APP.dispatch;
  if(row){
    row.innerHTML = d
      ? `<div class="fault-dispatch">
           <div>
             <div class="fd-label">Assigned to</div>
             <div class="fd-name">${d.techName} · ${d.techPhone || 'no number'}</div>
           </div>
           <div class="fd-actions">
             <a class="call-btn" href="tel:${d.techPhone || ''}">📞 Call</a>
             <a class="sms-btn" href="${smsLink(d.techPhone, jobSmsText(d))}">💬 SMS</a>
           </div>
         </div>`
      : `<div class="fault-dispatch none">Nobody assigned yet. The rotation picks someone as soon as the leak is confirmed.</div>`;
  }

  $('faultModal').classList.add('show');
  $('faultModal').setAttribute('aria-hidden','false');
}
function closeFault(){
  $('faultModal').classList.remove('show');
  $('faultModal').setAttribute('aria-hidden','true');
}
// The fault report goes to everyone who has dashboard access,
// not to a single inbox. A leak is something the whole team
// should know about, while the job itself still belongs to one
// named technician who gets the call and the SMS.
//
// Sent through EmailJS so it works on any device. The old
// mailto: version did nothing on phones with no mail app.
function sendFaultEmail(){
  if(APP.lastEmailSentAt && (Date.now() - APP.lastEmailSentAt < 60000)){
    showToast('⚠ Already sent', 'A report was recently sent');
    return;
  }
  const r = APP.faultReport || buildFaultReport();
  const btn = $('sendFaultBtn');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  // One send per recipient. EmailJS templates go to one address
  // at a time, so the list is walked rather than sent in bulk.
  const sends = faultRecipients().map(address =>
    emailjs.send(MAIL.service, MAIL.fault, {
      email:          address,
      subject:        `[URGENT] Water Leak Detected. ${r.zones}. Aqua Logic`,
      reply_to:       r.operator_email,
      zones:          r.zones,
      datetime:       r.datetime,
      operator:       r.operator,
      contact:        r.contact,
      operator_email: r.operator_email,
      assigned:       r.assigned,
      flow:           r.flow,
      details:        r.details
    })
  );

  Promise.allSettled(sends).then(results => {
    const sent   = results.filter(x => x.status === 'fulfilled').length;
    const failed = results.length - sent;
    btn.disabled = false;
    btn.textContent = 'Send Report';

    if(!sent){
      console.error(results);
      showToast('❌ Report failed', 'Nothing went out. Check your connection and try again.');
      return;
    }
    APP.lastEmailSentAt = Date.now();
    logEvent('email',
      `Fault report for ${r.zones} sent to ${sent} of ${results.length} team members`,
      nowTime(),
      'System');
    closeFault();
    showToast(
      '📧 Team notified',
      failed
        ? `${sent} of ${results.length} emails went out. ${failed} failed.`
        : `All ${sent} team members have the report.`
    );
  });
}
function acknowledge(zone){
  logEvent('system',`Zone ${zone}: Incident acknowledged by operator`,new Date().toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit'}),`Zone ${zone}`);
  showToast('📝 Acknowledged', `Zone ${zone} acknowledged`);
  if(APP.forcedLeakZone===zone){
    APP.forcedLeakZone = null;
    APP.forcedLeakUntil = 0;
  }
  renderZones(APP.liveData || {});
}

// ============================================================
// OFFLINE DEMO AND SMALL UTILITIES
// ============================================================
// Local only demo trigger, for testing the dashboard before the
// ESP32 is running. Builds a believable pressure profile with a
// 1.50 bar collapse across the chosen zone, plus a matching
// shortfall between flow in and flow out. Writes nothing to
// Firebase.
function simulateLeak(zoneId){
  APP.forcedLeakZone = zoneId || (['A','B','C'])[Math.floor(Math.random()*3)];
  // The demo lasts 60 seconds, then the dashboard goes back to
  // showing whatever the hardware is actually reporting.
  APP.forcedLeakUntil = Date.now() + 60000;
  const seg = ZONE_SEGMENTS[APP.forcedLeakZone] || [];
  let val = 850;
  const fake = {};
  PRESSURE_POINTS.forEach(pt => {
    fake[pt.key] = Math.round(val);
    val -= (pt.key === seg[0]) ? 150 : 15;
  });
  const fakeIn  = 60 + Math.random() * 20;
  const fakeOut = fakeIn - (12 + Math.random() * 6);
  APP.liveData = Object.assign({}, APP.liveData || {}, {
    pressure: fake,
    flow: {
      in:  Number(fakeIn.toFixed(1)),
      out: Number(fakeOut.toFixed(1))
    }
  });
  showToast('⚠ Demo leak', 'A demo leak has been triggered: ' + APP.forcedLeakZone);
  renderPressure(APP.liveData);
  renderFlow(APP.liveData);
  renderZones(APP.liveData);
}
// ============================================================
// REPORT A LEAK. THE PUBLIC FORM
//
// Anyone can open this from the landing page. It writes into
// /reports in the Realtime Database, which the dashboard is
// listening to, so an operator sees the report the moment it
// is sent. Nothing is emailed from here. The record itself is
// the notification.
//
// /reports sits outside /aqualogic on purpose. The ESP32 sends
// an HTTP PUT to /aqualogic.json, and a PUT replaces that whole
// node, so anything kept inside it would be wiped on the next
// sensor push.
// ============================================================
const REPORT_FIELDS = ['rp-name','rp-phone','rp-area','rp-desc'];

function openReport(){
  resetReportForm();
  $('reportModal').classList.add('show');
  $('reportModal').setAttribute('aria-hidden','false');
  setTimeout(()=>{ const f = $('rp-name'); if(f) f.focus(); }, 80);
}
function closeReport(){
  $('reportModal').classList.remove('show');
  $('reportModal').setAttribute('aria-hidden','true');
}
function resetReportForm(){
  // The panel is rebuilt each time it opens, because after a
  // successful send it holds the thank you screen instead.
  $('reportContent').innerHTML = reportFormHTML();
}
// The reference is what the caller quotes if they phone in to
// ask about their report, so it has to be short and readable.
function makeRef(){
  const d = new Date();
  const stamp = String(d.getDate()).padStart(2,'0') + String(d.getMonth()+1).padStart(2,'0');
  const rand = Math.floor(1000 + Math.random()*9000);
  return `AL-${stamp}-${rand}`;
}
function submitReport(){
  const name  = ($('rp-name')||{}).value?.trim() || '';
  const phone = ($('rp-phone')||{}).value?.trim() || '';
  const area  = ($('rp-area')||{}).value?.trim() || '';
  const zone  = ($('rp-zone')||{}).value || '';
  const desc  = ($('rp-desc')||{}).value?.trim() || '';
  const sev   = ($('rp-sev')||{}).value || 'medium';

  // Only the things the control room genuinely cannot work
  // without are required. Asking for more than that makes
  // people give up halfway.
  if(!name || !phone || !area){
    showToast('⚠ A few details missing', 'Please give your name, a phone number and where the water is');
    return;
  }
  if(phone.replace(/\D/g,'').length < 9){
    showToast('⚠ Check the phone number', 'That number looks too short');
    return;
  }

  const ref = makeRef();
  const btn = $('rpSendBtn');
  setBtnLoading(btn, true, 'Sending...');

  rtdb.ref('/reports').push({
    ref:        ref,
    name:       name,
    phone:      normalizePhoneNumber(phone),
    area:       area,
    zone:       zone || '',
    desc:       desc || 'No description given',
    severity:   sev,
    source:     'website',
    status:     'new',
    ts:         Date.now()
  })
  .then(()=>{
    $('reportContent').innerHTML = reportDoneHTML(ref);

    // Copy the report to the control room inbox. The dashboard
    // already has it, but nobody is necessarily looking at the
    // dashboard at two in the morning. An email waits.
    //
    // This is deliberately after the success screen and it never
    // blocks. If the mail fails, the report is still saved and
    // the person has still been given their reference.
    emailCopyToControlRoom({ ref, name, phone, area, zone, desc, sev });
  })
  .catch(err=>{
    console.error('Report could not be saved', err);
    setBtnLoading(btn, false);
    showToast('❌ Could not send', 'Check your connection and try again');
  });
}
// Emails a copy of a public report to the control room inbox.
// Fails quietly on purpose. The database is the record, the
// email is only a nudge, so a mail problem must never stop
// somebody reporting a burst pipe.
function emailCopyToControlRoom(r){
  if(typeof emailjs === 'undefined' || !MAIL.publicReport) return;

  emailjs.send(MAIL.service, MAIL.publicReport, {
    email:      CONTROL_ROOM_EMAIL,
    subject:    `New leak report ${r.ref}${r.zone ? ' in Zone ' + r.zone : ''}`,
    reference:  r.ref,
    reporter:   r.name || 'Not given',
    phone:      r.phone || 'Not given',
    reply_to:   '',
    area:       r.area || 'Not given',
    zone:       r.zone ? 'Zone ' + r.zone : 'Not stated',
    severity:   SEV_LABEL[r.sev] || r.sev || 'Not stated',
    description: r.desc || 'No description given',
    datetime:   new Date().toLocaleString('en-ZA',{dateStyle:'full',timeStyle:'short'})
  }).catch(err => console.warn('Report copy not emailed', err));
}
function reportDoneHTML(ref){
  return `
    <div class="report-done">
      <div class="tick">✓</div>
      <h3>Thank you. We have it.</h3>
      <p>Your report is on the control room screen right now. Keep this reference in case you need to follow up.</p>
      <div class="ref-code">${ref}</div>
      <p style="font-size:.84rem">If the water is a danger to people or traffic, please also phone the hotline on <strong>0860 000 000</strong>.</p>
      <div class="report-actions" style="margin-top:20px">
        <button class="btn btn-ghost btn-block" onclick="closeReport()">Close</button>
      </div>
    </div>`;
}
function reportFormHTML(){
  return `
    <div class="report-head">
      <div class="report-badge">💧 Public report</div>
      <h3>Report a water leak</h3>
      <p>Tell us where the water is. The control room sees this the moment you send it.</p>
    </div>

    <div class="field">
      <input id="rp-name" type="text" placeholder=" " autocomplete="name"/>
      <label for="rp-name">Your name</label>
    </div>

    <div class="field">
      <input id="rp-phone" type="tel" placeholder=" " autocomplete="tel"/>
      <label for="rp-phone">Phone number, so we can call you back</label>
    </div>

    <div class="field">
      <input id="rp-area" type="text" placeholder=" "/>
      <label for="rp-area">Street or landmark nearest to the water</label>
    </div>

    <div class="field">
      <label class="static-label" for="rp-zone">Area, if you know it</label>
      <select id="rp-zone">
        <option value="">I am not sure which area</option>
        <option value="A">Zone A. Northern Sector</option>
        <option value="B">Zone B. Central Pipeline</option>
        <option value="C">Zone C. Southern Grid</option>
      </select>
    </div>

    <div class="field">
      <textarea id="rp-desc" rows="3" placeholder=" "></textarea>
      <label for="rp-desc">What do you see? For example, water coming up through the road</label>
    </div>

    <div class="field">
      <label class="static-label" for="rp-sev">How bad is it?</label>
      <select id="rp-sev">
        <option value="low">A slow trickle</option>
        <option value="medium" selected>A steady stream</option>
        <option value="high">Water gushing or flooding</option>
      </select>
    </div>

    <p class="privacy-note">
      Your name and number are used only to follow up on this report and to let you know when it is resolved.
    </p>

    <div class="report-actions">
      <button class="btn btn-alert btn-block" id="rpSendBtn" onclick="submitReport()">Send report</button>
      <button class="btn btn-ghost" onclick="closeReport()">Cancel</button>
    </div>`;
}

// ============================================================
// CITIZEN REPORTS ON THE DASHBOARD
// A live listener on /reports. It fires once with everything
// already stored, then again on every new report, so all open
// dashboards stay in step without anyone pressing refresh.
// ============================================================
let reportsRef = null;
const SEV_LABEL = { low:'Slow trickle', medium:'Steady stream', high:'Gushing' };
const STATUS_ORDER = ['new','acknowledged','dispatched','resolved'];

function startReports(){
  if(reportsRef) return;
  reportsRef = rtdb.ref('/reports').limitToLast(60);
  reportsRef.on('value', snap => {
    const rows = [];
    snap.forEach(child => { rows.push(Object.assign({ id: child.key }, child.val())); });
    rows.reverse();  // Firebase hands them back oldest first

    // Anything that was not in the list a moment ago is new, so
    // the operator gets a toast rather than having to notice a
    // card appear somewhere down the page.
    const known = APP.seenReportIds;
    if(known.length){
      rows.filter(r => !known.includes(r.id)).forEach(r => {
        // If the sensors are already flagging that zone, this is
        // not just another report, it is confirmation.
        const confirms = r.zone && APP.leakZones.includes(r.zone);
        showToast(
          confirms ? '🔴 Report confirms a live leak' : '📣 New leak report',
          confirms
            ? `Zone ${r.zone} is already showing a pressure drop. ${r.area || ''}`.trim()
            : `${r.area || 'Location not given'}. Reference ${r.ref || r.id}`
        );
      });
    }
    APP.seenReportIds = rows.map(r => r.id);
    APP.reports = rows;
    renderReports();
    // The zone cards show how many reports sit in each zone, so
    // they are redrawn whenever the report list changes.
    if(APP.user) renderZones(APP.liveData || {});
  }, err => {
    console.error('Reports read failed', err);
    showToast('⚠ Reports unavailable', 'Could not load reports from the public');
  });
}
function stopReports(){
  if(reportsRef) reportsRef.off();
  reportsRef = null;
  APP.reports = [];
  APP.seenReportIds = [];
}
function filterReports(f){
  APP.reportFilter = f;
  document.querySelectorAll('.report-filters .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.rf === f);
  });
  renderReports();
}
function scrollToReports(){
  const el = $('reportsSection');
  if(el) el.scrollIntoView({behavior:'smooth', block:'start'});
}
function renderReports(){
  const list = $('reportsList');
  if(!list) return;

  const f = APP.reportFilter || 'all';
  const rows = (f === 'all') ? APP.reports : APP.reports.filter(r => (r.status || 'new') === f);

  // The badge counts everything still waiting to be looked at,
  // not just what is on screen under the current filter.
  const unread = APP.reports.filter(r => (r.status || 'new') === 'new').length;
  const bell = $('bellCount');
  const pill = $('unreadPill');
  if(bell){
    bell.textContent = unread;
    bell.style.display = unread ? 'flex' : 'none';
  }
  if(pill){
    pill.textContent = `${unread} new`;
    pill.style.display = unread ? 'inline-block' : 'none';
  }

  if(!rows.length){
    list.innerHTML = `<div class="empty-state">${
      f === 'all'
        ? 'No reports from the public yet. Anything sent through the website lands here.'
        : `Nothing with the status "${f}" right now.`
    }</div>`;
    return;
  }

  list.innerHTML = rows.map(r => {
    const status = r.status || 'new';
    const when = r.ts ? new Date(r.ts).toLocaleString('en-ZA',{dateStyle:'short',timeStyle:'short'}) : '';
    const sev = r.severity || 'medium';
    const assigned = r.assignedName
      ? `<div class="report-assigned">🔧 Assigned to <strong>${r.assignedName}</strong>${
          r.assignedPhone ? ` · <a class="tech-phone" style="display:inline" href="tel:${r.assignedPhone}">${r.assignedPhone}</a>` : ''
        }</div>`
      : '';
    return `
      <div class="report-card ${status === 'new' ? 'is-new' : ''}">
        <div class="report-card-top">
          <div>
            <div class="report-ref">${r.ref || r.id}</div>
            <div class="report-when">${when}${r.source === 'email' ? ' · from email' : ''}</div>
          </div>
          <div class="status-pill ${status}">${status}</div>
        </div>

        <div class="report-where">${r.area || 'Location not given'}</div>
        <div class="report-desc">${r.desc || ''}</div>

        ${status === 'resolved' ? '' : matchLineHTML(r)}

        <div class="report-meta">
          ${r.zone ? `<span class="meta-tag">📍 Zone ${r.zone}</span>` : `<span class="meta-tag">📍 Zone unknown</span>`}
          <span class="meta-tag sev-${sev}">💧 ${SEV_LABEL[sev] || sev}</span>
          <span class="meta-tag">👤 ${r.name || 'Anonymous'}</span>
          ${r.phone ? `<a class="meta-tag" style="text-decoration:none" href="tel:${r.phone}">📞 ${r.phone}</a>` : ''}
        </div>

        ${assigned}

        <div class="report-actions-row">
          ${status === 'new' ? `<button class="mini-btn" onclick="acknowledgeReport('${r.id}')">Acknowledge</button>` : ''}
          ${(status === 'new' || status === 'acknowledged') && isAdmin()
              ? `<button class="mini-btn go" onclick="dispatchReport('${r.id}')">Dispatch a technician</button>` : ''}
          ${status !== 'resolved' ? `<button class="mini-btn" onclick="resolveReport('${r.id}')">Mark resolved</button>` : ''}
        </div>
      </div>`;
  }).join('');
}
function findReport(id){
  return APP.reports.find(r => r.id === id);
}

// ============================================================
// CROSS CHECKING THE TWO SOURCES
//
// The system hears about a leak in two independent ways. The
// sensors underground, and people standing in the street. Put
// side by side they mean three different things:
//
//   both agree      a confirmed leak, dispatch straight away
//   only the public either it is past the last sensor, or it is
//                   still too small to move the pressure
//   only the sensors nobody can see it, which is the buried leak
//                   that runs for weeks. Silence is not good news.
//
// Neither source is thrown away. They are shown next to each
// other so the operator can see which of the three they have.
// ============================================================
function openReportsInZone(zone){
  if(!zone) return [];
  return APP.reports.filter(r => r.zone === zone && (r.status || 'new') !== 'resolved');
}
// A demo leak counts as sensor information too, otherwise every
// report says "no sensor data" while the hardware is unplugged.
function sensorDataAvailable(){
  return APP.deviceOnline || !!APP.forcedLeakZone;
}
function sensorsAgreeWith(report){
  if(!report.zone) return 'unknown';
  if(APP.leakZones.includes(report.zone)) return 'agree';
  return sensorDataAvailable() ? 'quiet' : 'offline';
}
function matchLineHTML(report){
  const state = sensorsAgreeWith(report);
  if(state === 'agree'){
    return `<div class="match-line agree">🔴 <span><strong>Sensors agree.</strong> Zone ${report.zone} is losing pressure right now. Treat this as confirmed.</span></div>`;
  }
  if(state === 'quiet'){
    return `<div class="match-line quiet">🔍 <span><strong>Sensors are quiet in Zone ${report.zone}.</strong> The leak may sit past the last sensor, or be too small to show yet. Still worth a look.</span></div>`;
  }
  if(state === 'offline'){
    return `<div class="match-line quiet">📡 <span>No sensor data at the moment, so this report cannot be cross checked.</span></div>`;
  }
  return `<div class="match-line quiet">📍 <span>No area given, so this cannot be matched against a sensor.</span></div>`;
}
function acknowledgeReport(id){
  const r = findReport(id);
  rtdb.ref('/reports/' + id).update({
    status: 'acknowledged',
    acknowledgedBy: APP.user?.name || 'Operator',
    acknowledgedAt: Date.now()
  }).then(()=>{
    logEvent('report', `Report ${r?.ref || id} acknowledged`, nowTime(), r?.zone ? `Zone ${r.zone}` : 'Public report');
    showToast('📝 Acknowledged', 'The report has been marked as seen');
  }).catch(err=>{
    console.error(err);
    showToast('❌ Not saved', 'Could not update the report');
  });
}
function resolveReport(id){
  const r = findReport(id);
  rtdb.ref('/reports/' + id).update({
    status: 'resolved',
    resolvedBy: APP.user?.name || 'Operator',
    resolvedAt: Date.now()
  }).then(()=>{
    logEvent('report', `Report ${r?.ref || id} marked resolved`, nowTime(), r?.zone ? `Zone ${r.zone}` : 'Public report');
    showToast('✅ Resolved', 'The report has been closed');
  }).catch(err=>{
    console.error(err);
    showToast('❌ Not saved', 'Could not update the report');
  });
}
// Sends the next technician on the rotation to a report from
// the public, and writes their name onto the report so anyone
// looking at it later knows who went.
function dispatchReport(id){
  const r = findReport(id);
  if(!r) return;
  const tech = nextTechnician();
  if(!tech){
    showToast('⚠ Nobody available', 'Every technician is marked unavailable. Check the team list.');
    return;
  }
  assignTechnician(tech, {
    reason: `Public report ${r.ref || id}`,
    zone:   r.zone ? `Zone ${r.zone}` : 'Zone unknown',
    area:   r.area || ''
  });
  rtdb.ref('/reports/' + id).update({
    status:        'dispatched',
    assignedTo:    tech.id,
    assignedName:  tech.name,
    assignedPhone: tech.phone,
    dispatchedBy:  APP.user?.name || 'Operator',
    dispatchedAt:  Date.now()
  }).catch(err=>{
    console.error(err);
    showToast('❌ Not saved', 'Could not update the report');
  });
}
function nowTime(){
  return new Date().toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit'});
}

// ============================================================
// ACCESS REQUESTS
//
// This is what replaced the hardcoded list of email addresses.
//
// Anyone can register. Registering writes a pending account and
// nothing else. An administrator sees it here, decides whether
// the person is an administrator or a technician, and approves
// or declines. Approving as a technician is the only thing that
// puts a name on the call out rotation.
//
// Only administrators read this node. The database rules refuse
// the read for everyone else, so a technician cannot list the
// other accounts even by typing into the browser console.
// ============================================================
let usersRef = null;

function startAccessRequests(){
  if(usersRef) return;
  if(!isAdmin()) return;

  usersRef = rtdb.ref('/users');
  usersRef.on('value', snap => {
    const rows = [];
    snap.forEach(child => { rows.push(Object.assign({ uid: child.key }, child.val())); });

    // Newest request first, so the person who has been waiting
    // the least appears at the bottom, not buried at the top.
    rows.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));

    const pendingNow = rows.filter(r => r.status === STATUS.PENDING);

    // Tell the administrator when a new request lands while they
    // are already looking at the screen. The first pass after
    // login is skipped, otherwise every existing request would
    // toast at once.
    if(APP.seenRequestIds.length){
      pendingNow
        .filter(r => !APP.seenRequestIds.includes(r.uid))
        .forEach(r => showToast('🔔 New access request', `${r.name || 'Someone'} ${r.surname || ''} is asking for access`, 6000));
    }
    APP.seenRequestIds = pendingNow.map(r => r.uid);

    APP.accessRequests = rows;
    renderAccessRequests();
  }, err => {
    console.error('Could not read the account list', err);
    const box = $('requestsList');
    if(box){
      box.innerHTML = `<div class="empty-state" style="border:none">Could not load accounts. Check that the database rules are published.</div>`;
    }
  });
}
function stopAccessRequests(){
  if(usersRef) usersRef.off();
  usersRef = null;
  APP.accessRequests = [];
  APP.seenRequestIds = [];
}
function filterUsers(key){
  APP.userFilter = key;
  document.querySelectorAll('[data-uf]').forEach(b => {
    b.classList.toggle('active', b.dataset.uf === key);
  });
  renderAccessRequests();
}
function renderAccessRequests(){
  const box = $('requestsList');
  if(!box) return;

  const filter  = APP.userFilter || 'pending';
  const pending = APP.accessRequests.filter(r => r.status === STATUS.PENDING);

  // The count badge on the section heading, and the tab pill.
  const pill = $('pendingPill');
  if(pill){
    pill.textContent = `${pending.length} waiting`;
    pill.style.display = pending.length ? 'inline-flex' : 'none';
  }
  const tabCount = $('pendingTabCount');
  if(tabCount) tabCount.textContent = pending.length ? ` (${pending.length})` : '';

  // Suspended accounts sit under the declined tab. They are both
  // "cannot sign in", and a fourth tab for one case is clutter.
  const rows = APP.accessRequests.filter(r => {
    const s = r.status || STATUS.PENDING;
    if(filter === 'declined') return s === STATUS.DECLINED || s === STATUS.SUSPENDED;
    return s === filter;
  });

  if(!rows.length){
    const blank = {
      pending:  'No requests waiting. New registrations land here.',
      approved: 'Nobody has been approved yet.',
      declined: 'Nothing has been declined or suspended.'
    };
    box.innerHTML = `<div class="empty-state" style="border:none;padding:22px 0">${blank[filter] || 'Nothing to show.'}</div>`;
    return;
  }

  box.innerHTML = rows.map(r => {
    const full = `${r.name || ''} ${r.surname || ''}`.trim() || 'Unnamed';
    const when = r.createdAt
      ? new Date(r.createdAt).toLocaleString('en-ZA',{dateStyle:'medium',timeStyle:'short'})
      : 'Unknown date';
    const asked = r.requestedRole === 'admin' ? 'Administrator' : 'Maintenance technician';

    let actions = '';
    let badge   = '';

    if(r.status === STATUS.PENDING){
      badge = `<span class="req-badge pending">Waiting</span>`;
      actions = `
        <button class="btn btn-primary btn-sm" onclick="approveUser('${r.uid}','admin')">Approve as Administrator</button>
        <button class="btn btn-primary btn-sm" onclick="approveUser('${r.uid}','maintenance')">Approve as Technician</button>
        <button class="btn btn-ghost btn-sm" onclick="declineUser('${r.uid}')">Decline</button>`;
    } else if(r.status === STATUS.APPROVED){
      badge = `<span class="req-badge approved">${r.role === 'admin' ? 'Administrator' : 'Technician'}</span>`;
      actions = `
        <button class="btn btn-ghost btn-sm" onclick="suspendUser('${r.uid}')">Suspend access</button>`;
    } else if(r.status === STATUS.SUSPENDED){
      badge = `<span class="req-badge declined">Suspended</span>`;
      actions = `
        <button class="btn btn-primary btn-sm" onclick="approveUser('${r.uid}','${r.role || 'maintenance'}')">Restore access</button>`;
    } else {
      badge = `<span class="req-badge declined">Declined</span>`;
      actions = `
        <button class="btn btn-primary btn-sm" onclick="approveUser('${r.uid}','maintenance')">Approve as Technician</button>
        <button class="btn btn-primary btn-sm" onclick="approveUser('${r.uid}','admin')">Approve as Administrator</button>`;
    }

    const decided = r.decidedAt
      ? `<div class="req-decided">Decided ${new Date(r.decidedAt).toLocaleString('en-ZA',{dateStyle:'short',timeStyle:'short'})}${r.decidedBy ? ' by ' + r.decidedBy : ''}</div>`
      : '';

    return `
      <div class="request-card">
        <div class="req-avatar">${initials(full)}</div>
        <div class="req-main">
          <div class="req-name">${full} ${badge}</div>
          <div class="req-meta">
            <span>✉ <a href="mailto:${r.email || ''}">${r.email || 'No email'}</a></span>
            <span>📞 <a href="tel:${r.phone || ''}">${r.phone || 'No number'}</a></span>
          </div>
          <div class="req-meta">
            <span>Applied as: <strong>${asked}</strong></span>
            <span>Registered ${when}</span>
          </div>
          ${decided}
        </div>
        <div class="req-actions">${actions}</div>
      </div>`;
  }).join('');
}
// Approving does two things. It writes the role and the approved
// status onto the account, and if the role is maintenance it puts
// the person on the call out rotation using their own details.
function approveUser(uid, role){
  if(!isAdmin()){
    showToast('🔒 Not allowed', 'Only an administrator can approve accounts');
    return;
  }
  const person = APP.accessRequests.find(r => r.uid === uid);
  if(!person){
    showToast('⚠ Not found', 'That account is no longer on the list');
    return;
  }
  const full = `${person.name || ''} ${person.surname || ''}`.trim() || 'The account';

  const updates = {};
  updates['users/' + uid + '/status']    = STATUS.APPROVED;
  updates['users/' + uid + '/role']      = role;
  updates['users/' + uid + '/decidedAt'] = Date.now();
  updates['users/' + uid + '/decidedBy'] = APP.user?.email || 'administrator';

  if(role === 'maintenance'){
    // The technician's own name and number, taken from what they
    // typed when they registered. Nothing is invented here.
    updates['team/' + uid] = {
      name:  full,
      role:  'Maintenance technician',
      phone: person.phone || '',
      email: person.email || '',
      active: true,
      lastAssignedAt: 0,
      joinedAt: Date.now()
    };
  } else {
    // Somebody moved from technician to administrator comes off
    // the rotation, so they are not called out any more.
    updates['team/' + uid] = null;
  }

  rtdb.ref().update(updates)
    .then(() => showToast('✅ Approved',
      role === 'maintenance'
        ? `${full} can sign in and is on the call out rotation`
        : `${full} can sign in as an administrator`))
    .catch(err => {
      console.error(err);
      showToast('❌ Not saved', 'Could not approve this account. Check the database rules.');
    });
}
function declineUser(uid){
  if(!isAdmin()){
    showToast('🔒 Not allowed', 'Only an administrator can decline accounts');
    return;
  }
  const person = APP.accessRequests.find(r => r.uid === uid);
  const full = `${person?.name || ''} ${person?.surname || ''}`.trim() || 'The account';

  const updates = {};
  updates['users/' + uid + '/status']    = STATUS.DECLINED;
  updates['users/' + uid + '/decidedAt'] = Date.now();
  updates['users/' + uid + '/decidedBy'] = APP.user?.email || 'administrator';
  updates['team/' + uid] = null;

  rtdb.ref().update(updates)
    .then(() => showToast('Declined', `${full} cannot sign in`))
    .catch(err => {
      console.error(err);
      showToast('❌ Not saved', 'Could not decline this account');
    });
}
// Switches off an account that was approved before, without
// deleting anything. Used when somebody leaves the team.
function suspendUser(uid){
  if(!isAdmin()){
    showToast('🔒 Not allowed', 'Only an administrator can suspend accounts');
    return;
  }
  if(uid === APP.user?.uid){
    showToast('⚠ Not allowed', 'You cannot suspend the account you are signed in with');
    return;
  }
  const person = APP.accessRequests.find(r => r.uid === uid);
  const full = `${person?.name || ''} ${person?.surname || ''}`.trim() || 'The account';

  const updates = {};
  updates['users/' + uid + '/status']    = STATUS.SUSPENDED;
  updates['users/' + uid + '/decidedAt'] = Date.now();
  updates['users/' + uid + '/decidedBy'] = APP.user?.email || 'administrator';
  updates['team/' + uid] = null;

  rtdb.ref().update(updates)
    .then(() => showToast('⏸ Suspended', `${full} can no longer sign in`))
    .catch(err => {
      console.error(err);
      showToast('❌ Not saved', 'Could not suspend this account');
    });
}

// ============================================================
// MAINTENANCE TEAM AND ROTATION
//
// The operator watches the dashboard. The technicians are the
// people who actually go out and fix the pipe. They are two
// different roles, and the system needs to know both.
//
// Rotation rule: the next job goes to whoever has gone longest
// without one. That is fairer than a simple counter, because it
// still works after someone is added, removed, or marked
// unavailable for the day.
//
// There is no starting list and no placeholder names. The only
// way into /team is for a person to register and for an
// administrator to approve them as a technician. So every name
// on the rotation belongs to somebody real, with a phone number
// that actually rings.
// ============================================================

let teamRef = null;
let dispatchRef = null;

function startTeam(){
  if(teamRef) return;

  teamRef = rtdb.ref('/team');
  teamRef.on('value', snap => {
    const rows = [];
    snap.forEach(child => { rows.push(Object.assign({ id: child.key }, child.val())); });
    APP.team = rows;
    renderTeam();
    renderDispatch();
  }, err => {
    console.error('Team read failed', err);
    showToast('⚠ Team unavailable', 'Could not load the maintenance team');
  });

  // The current assignment lives in the database too, so every
  // operator sees the same dispatch, not just the one who made it.
  dispatchRef = rtdb.ref('/dispatch/current');
  dispatchRef.on('value', snap => {
    APP.dispatch = snap.val();
    renderDispatch();
  });
}
function stopTeam(){
  if(teamRef) teamRef.off();
  if(dispatchRef) dispatchRef.off();
  teamRef = null;
  dispatchRef = null;
  APP.team = [];
  APP.dispatch = null;
}
// Whoever is available and has waited the longest.
function nextTechnician(skipId){
  const pool = APP.team
    .filter(t => t.active !== false)
    .filter(t => !skipId || t.id !== skipId);
  if(!pool.length) return null;
  return pool.slice().sort((a,b) => (a.lastAssignedAt || 0) - (b.lastAssignedAt || 0))[0];
}
function initials(name){
  return (name || '?').split(/\s+/).map(p => p[0]).slice(0,2).join('').toUpperCase();
}
function renderTeam(){
  const box = $('teamList');
  if(!box) return;
  if(!APP.team.length){
    box.innerHTML = `
      <div class="empty-state" style="border:none;padding:20px 0">
        <div style="font-size:1.6rem;margin-bottom:6px">👷</div>
        <div style="font-weight:700;margin-bottom:4px">No technicians on the rotation yet</div>
        <div style="font-size:.85rem;opacity:.85">
          ${isAdmin()
            ? 'Technicians appear here once they register and you approve them as maintenance.'
            : 'Technicians appear here once an administrator approves them.'}
        </div>
      </div>`;
    return;
  }
  const next = nextTechnician();
  const onJob = APP.dispatch?.techId;

  // Sorted the same way the rotation picks, so the order on
  // screen is the order people will actually be called in.
  const sorted = APP.team.slice().sort((a,b) => (a.lastAssignedAt || 0) - (b.lastAssignedAt || 0));

  box.innerHTML = sorted.map(t => {
    const isNext = next && t.id === next.id && t.id !== onJob;
    const isBusy = t.id === onJob;
    const off    = t.active === false;
    const last   = t.lastAssignedAt
      ? new Date(t.lastAssignedAt).toLocaleString('en-ZA',{dateStyle:'short',timeStyle:'short'})
      : 'No jobs yet';
    let tag = '';
    if(off)          tag = '<span class="team-tag off">Unavailable</span>';
    else if(isBusy)  tag = '<span class="team-tag busy">On a job</span>';
    else if(isNext)  tag = '<span class="team-tag next">Next up</span>';
    // Only an administrator can change who is on the rotation.
    // A technician looking at this screen just sees the list.
    const admin = isAdmin() ? `
        <button class="team-mini" onclick="setTechnicianActive('${t.id}', ${off})"
                title="${off ? 'Put back on the rotation' : 'Mark as unavailable'}">
          ${off ? '↩' : '⏸'}
        </button>
        <button class="team-mini danger" onclick="removeTechnician('${t.id}')"
                title="Remove from the rotation">✕</button>` : '';

    return `
      <div class="team-row ${isNext ? 'next-up' : ''} ${off ? 'inactive' : ''}">
        <div class="team-avatar">${initials(t.name)}</div>
        <div class="team-info">
          <div class="team-name">${t.name || 'Unnamed'}</div>
          <div class="team-sub">${t.role || 'Technician'} · Last job: ${last}</div>
        </div>
        ${tag}
        <a class="team-call" href="tel:${t.phone || ''}" title="Call ${t.name || ''}">📞</a>
        ${admin}
      </div>`;
  }).join('');
}
// Off the rotation for the day, without deleting the person.
// nextTechnician() already skips anyone whose active flag is false.
function setTechnicianActive(id, makeActive){
  if(!isAdmin()){
    showToast('🔒 Not allowed', 'Only an administrator can change the rotation');
    return;
  }
  const tech = APP.team.find(t => t.id === id);
  rtdb.ref('team/' + id + '/active').set(!!makeActive)
    .then(() => showToast(
      makeActive ? '✅ Back on the rotation' : '⏸ Marked unavailable',
      `${tech?.name || 'The technician'} ${makeActive ? 'will be called again' : 'will be skipped until you switch them back on'}`))
    .catch(err => {
      console.error(err);
      showToast('❌ Not saved', 'Could not update the rotation');
    });
}
// Takes the person off the rotation for good. Their user account
// is left alone, so they can still sign in, they just stop being
// called out. Suspend the account instead if you want them out
// of the system entirely.
function removeTechnician(id){
  if(!isAdmin()){
    showToast('🔒 Not allowed', 'Only an administrator can change the rotation');
    return;
  }
  const tech = APP.team.find(t => t.id === id);
  // If this person is on the current job, clear the job first so
  // the dispatch card does not keep pointing at somebody who is
  // no longer on the list.
  const clearing = (APP.dispatch?.techId === id)
    ? rtdb.ref('/dispatch/current').remove()
    : Promise.resolve();

  clearing
    .then(() => rtdb.ref('team/' + id).remove())
    .then(() => showToast('🗑 Removed', `${tech?.name || 'The technician'} is no longer on the rotation`))
    .catch(err => {
      console.error(err);
      showToast('❌ Not removed', 'Could not update the rotation');
    });
}
// Writes the assignment. Two things are saved: the job itself,
// so every dashboard shows it, and the timestamp on the
// technician, which is what moves the rotation along.
function assignTechnician(tech, context){
  const job = {
    techId:    tech.id,
    techName:  tech.name,
    techPhone: tech.phone,
    // Carried through so the dispatch email has somewhere to go
    // without another lookup at the moment the button is pressed.
    techEmail: tech.email || '',
    techRole:  tech.role || 'Technician',
    reason:    context?.reason || 'Leak detected',
    zone:      context?.zone || 'Unknown zone',
    area:      context?.area || '',
    assignedBy: APP.user?.name || 'System',
    assignedAt: Date.now()
  };
  rtdb.ref('/dispatch/current').set(job).catch(err => console.error('Dispatch not saved', err));
  rtdb.ref('/team/' + tech.id + '/lastAssignedAt').set(Date.now())
      .catch(err => console.error('Rotation not updated', err));

  logEvent('dispatch',
    `${tech.name} assigned to ${job.zone}. ${job.reason}`,
    nowTime(),
    job.zone);

  // Assigning does not phone anybody by itself. Sending a person
  // out is a decision, and decisions get their own button, so that
  // shuffling the rotation cannot accidentally ring somebody at
  // three in the morning or spend money by mistake.
  showToast('🔧 Technician assigned',
    `${tech.name} is on ${job.zone}. Press Send to call, text and email them.`);
}
// Called when a sensor leak is confirmed. It only fires once per
// alarm, because renderZones runs several times a second while
// a leak is live.
function autoAssignForLeak(key){
  if(!key || APP.assignedForKey === key) return;
  // Assigning is a control room action, so it is done by the
  // administrator's screen. A technician watching the same leak
  // must not also try to write the assignment, or two browsers
  // would fight over the same job and the database would refuse
  // the write anyway.
  if(!isAdmin()) return;
  APP.assignedForKey = key;
  const tech = nextTechnician();
  if(!tech){
    showToast('⚠ Nobody available', 'A leak was detected but every technician is marked unavailable');
    return;
  }
  assignTechnician(tech, {
    reason: 'Sensor detected a leak',
    zone:   APP.leakZones.map(z => 'Zone ' + z).join(', ') || 'Unknown zone'
  });
}
// Hands the job to the next person instead, for when the
// operator knows something the rotation does not.
function reassignDispatch(){
  const current = APP.dispatch;
  if(!current){
    showToast('⚠ Nothing to reassign', 'There is no active dispatch');
    return;
  }
  const tech = nextTechnician(current.techId);
  if(!tech){
    showToast('⚠ Nobody else available', 'There is no other technician to hand this to');
    return;
  }
  logEvent('dispatch',
    `${current.techName} handed over to ${tech.name} by ${APP.user?.name || 'Operator'}`,
    nowTime(),
    current.zone || 'System');
  assignTechnician(tech, {
    reason: current.reason,
    zone:   current.zone,
    area:   current.area
  });
}
function clearDispatch(){
  const current = APP.dispatch;
  if(!current) return;
  rtdb.ref('/dispatch/current').remove()
    .then(()=>{
      logEvent('dispatch', `${current.techName} marked the job at ${current.zone} as complete`, nowTime(), current.zone || 'System');
      showToast('✅ Job closed', 'The dispatch has been cleared');
    })
    .catch(err => console.error(err));
}
// A text message the technician can act on without opening
// anything. This opens the phone's own messaging app with the
// words already written, so it costs nothing and needs no
// account. An automatic SMS would need the same paid service
// as the automatic call.
const STAGE_LABEL = {
  assigned: 'Waiting for the technician',
  accepted: 'Accepted',
  enroute:  'On the way',
  onsite:   'On site'
};
function smsLink(phone, body){
  return `sms:${phone || ''}?&body=${encodeURIComponent(body)}`;
}
function jobSmsText(d){
  return `Aqua Logic: you have been assigned to ${d.zone || 'a leak'}`
       + (d.area ? ` at ${d.area}` : '')
       + `. Reason: ${d.reason || 'leak detected'}. Please confirm.`;
}
// Who is looking at the screen decides which buttons appear.
// An administrator runs the job. The technician the job was
// given to works through it.
function dispatchActionsHTML(d){
  const mine = !isAdmin() && APP.user?.uid && d.techId === APP.user.uid;

  if(mine){
    const stage = d.stage || 'assigned';
    return `
      <div class="my-job">
        <div class="my-job-title">This one is yours</div>
        <p>${d.zone || 'Unknown zone'}${d.area ? ', ' + d.area : ''}. ${d.reason || ''}</p>
        <div class="job-steps">
          <button class="job-step ${stage !== 'assigned' ? 'done' : ''}" onclick="setJobStage('accepted')">
            ${stage !== 'assigned' ? '✓ Accepted' : 'Accept'}
          </button>
          <button class="job-step ${stage === 'enroute' || stage === 'onsite' ? 'done' : ''}" onclick="setJobStage('enroute')">
            ${stage === 'enroute' || stage === 'onsite' ? '✓ On my way' : 'On my way'}
          </button>
          <button class="job-step" onclick="clearDispatch()">Completed</button>
        </div>
      </div>`;
  }

  if(!isAdmin()){
    return `<div class="dispatch-actions">
      <a class="call-btn" href="tel:${d.techPhone || ''}">📞 Call ${(d.techName || '').split(' ')[0]}</a>
    </div>`;
  }

  // The first button is the important one. It sends the technician
  // out and silences the alarm in a single press.
  //
  // The two links below it stay because they are the fallback when
  // the automatic send fails, or when the operator simply wants to
  // speak to the person directly. They open the phone's own apps
  // and cost nothing.
  return `
    <div class="dispatch-actions">
      <button id="notifyBtn" class="call-btn" onclick="notifyTechnician()">
        📣 Send ${(d.techName || '').split(' ')[0]}: call, text and email
      </button>
      <a class="call-btn" href="tel:${d.techPhone || ''}">📞 Ring them myself</a>
      <a class="sms-btn" href="${smsLink(d.techPhone, jobSmsText(d))}">💬 Text myself</a>
      <button class="ctrl" onclick="reassignDispatch()">Hand to next technician</button>
      <button class="ctrl" onclick="clearDispatch()">Job complete</button>
    </div>`;
}
// The technician moving their own job along. Everyone watching
// the dashboard sees the stage change as it happens.
function setJobStage(stage){
  if(!APP.dispatch) return;
  const labels = { accepted:'accepted the job', enroute:'is on the way' };
  rtdb.ref('/dispatch/current/stage').set(stage)
    .then(()=>{
      logEvent('dispatch',
        `${APP.dispatch.techName || 'Technician'} ${labels[stage] || stage} for ${APP.dispatch.zone || 'the job'}`,
        nowTime(),
        APP.dispatch.zone || 'System');
      showToast('✅ Updated', 'The control room can see this');
    })
    .catch(err => console.error(err));
}

function renderDispatch(){
  const box  = $('dispatchCard');
  const meta = $('dispatchMeta');
  if(!box) return;

  const d = APP.dispatch;
  if(!d){
    const next = nextTechnician();
    if(meta) meta.textContent = 'Nobody dispatched';

    // The send button used to exist only once somebody had been
    // assigned, which meant that during a live leak there was
    // often nothing to press. Now the empty state offers to do
    // both at once: assign the next person and send them.
    box.innerHTML = `
      <div class="dispatch-empty">
        No active dispatch. Nothing needs a technician right now.
        ${next ? `<br><br>Next in the rotation is <strong style="color:#00e5a0">${next.name}</strong>.` : ''}
      </div>
      ${next && isAdmin() ? `
        <div class="dispatch-actions">
          <button class="call-btn" onclick="dispatchNextNow()">
            📣 Send ${next.name.split(' ')[0]} now: call, text and email
          </button>
          <button class="ctrl" onclick="silenceAlarm()">🔕 Silence my phone</button>
        </div>` : ''}`;
    return;
  }

  const since = d.assignedAt
    ? new Date(d.assignedAt).toLocaleString('en-ZA',{dateStyle:'short',timeStyle:'short'})
    : '—';
  if(meta) meta.textContent = 'Assigned ' + since;

  box.innerHTML = `
    <div class="dispatch-active">
      <div class="tech-head">
        <div class="tech-avatar">${initials(d.techName)}</div>
        <div style="flex:1;min-width:0">
          <div class="tech-name">${d.techName}</div>
          <div class="tech-role">${d.techRole || 'Technician'}</div>
          <a class="tech-phone" href="tel:${d.techPhone || ''}">${d.techPhone || 'No number saved'}</a>
        </div>
      </div>

      <div class="dispatch-meta-row"><span class="k">Location</span><span class="v">${d.zone || '—'}</span></div>
      ${d.area ? `<div class="dispatch-meta-row"><span class="k">Reported at</span><span class="v">${d.area}</span></div>` : ''}
      <div class="dispatch-meta-row"><span class="k">Reason</span><span class="v">${d.reason || '—'}</span></div>
      <div class="dispatch-meta-row"><span class="k">Assigned by</span><span class="v">${d.assignedBy || 'System'}</span></div>
      <div class="dispatch-meta-row"><span class="k">Progress</span><span class="v">${STAGE_LABEL[d.stage || 'assigned']}</span></div>

      ${dispatchActionsHTML(d)}
    </div>`;

  // The fault report is usually already on screen by the time a
  // technician is picked, so it gets rebuilt here. Without this
  // the emailed report would still say nobody was assigned.
  const fm = $('faultModal');
  if(fm && fm.classList.contains('show')) openFaultModal();
}
// ------------------------------------------------------------
// AUTOMATIC CALLING GOES HERE LATER
//
// Right now the system tells the operator who to ring and puts
// the number one tap away. That needs no account and costs
// nothing.
//
// To make the system ring the technician on its own, put a
// serverless function on Netlify holding the Twilio credentials
// and call it from here:
//
//   fetch('/.netlify/functions/call-technician', {
//     method:'POST',
//     headers:{'Content-Type':'application/json'},
//     body: JSON.stringify({ to: tech.phone, zone: job.zone })
//   });
//
// The credentials must never be written into this file. Anyone
// can open app.js in the browser and read it.
// ------------------------------------------------------------
// Pulls the zone number out of text like "Zone 2" or
// "Zone 1, Zone 3". The dispatch record stores it as words for
// display, but the phone call needs the bare number.
function zoneNumber(text){
  const found = String(text || '').match(/\d+/);
  return found ? Number(found[0]) : 0;
}

// ===================== DISPATCH A TECHNICIAN =====================
//
// One press does two jobs, because for the person at the desk they
// are one action: it tells the system the leak has been seen, which
// stops the phone ringing every five minutes, and it sends the
// technician out by phone, text and email.
//
// The call and the text are placed by Netlify, not here, because
// the phone account details must never sit in a file the public
// can read. The email goes straight from this browser through
// EmailJS, which is built for exactly that.
// Silences the alarm without sending anybody out.
//
// The alarm rings every five minutes and never gives up, which is
// correct for a burst pipe. It is only correct if there is always
// a way to say you have seen it. This is that way, and it is on
// the leak card itself so it is reachable the moment you look at
// the screen.
async function silenceAlarm(zone){
  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/.netlify/functions/notify-technician', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ acknowledgeOnly: true })
    });
    const out = await res.json();

    if(out.acknowledged){
      showToast('🔕 Alarm silenced', 'Your phone will stop ringing. The leak is still open.');
      logEvent('system', `Alarm acknowledged by ${out.by || 'operator'}`, nowTime(), zone ? `Zone ${zone}` : 'System');
    } else {
      showToast('Nothing to silence', out.reason || out.error || 'There is no active alarm.');
    }
  } catch (err) {
    showToast('Could not silence it', err.message);
  }
}

// Assigns whoever is next on the rotation and sends them, in one
// press. This exists because the send button used to live inside
// the dispatch card, which is empty until an assignment has
// happened, so during a real leak there was often no button to
// press at all. Now there always is.
async function dispatchNextNow(){
  if(!isAdmin()){
    showToast('Not allowed', 'Only an administrator can dispatch.');
    return;
  }

  const tech = nextTechnician();
  if(!tech){
    showToast('Nobody available', 'Every technician is marked unavailable. Check the team list.');
    return;
  }

  const zone = (APP.leakZones && APP.leakZones.length)
    ? APP.leakZones.map(z => 'Zone ' + z).join(', ')
    : 'Zone unknown';

  assignTechnician(tech, { reason: 'Dispatched by operator', zone });

  // The job is built here rather than read back from APP.dispatch,
  // because that only updates once Firebase has echoed the write
  // back, which is a moment later. Waiting on it would mean the
  // first press silently did nothing.
  await notifyTechnician({
    techId:    tech.id,
    techName:  tech.name,
    techPhone: tech.phone,
    techEmail: tech.email || '',
    zone,
    assignedBy: APP.user?.name || 'Control room'
  });
}

async function notifyTechnician(job){
  const d = job || APP.dispatch;
  if(!d || !d.techId){
    showToast('Nobody to send', 'Assign a technician first.');
    return;
  }

  const btn = document.getElementById('notifyBtn');
  if(btn){
    btn.disabled = true;
    btn.textContent = 'Sending...';
  }

  const zone = zoneNumber(d.zone);
  let calledOk = false;
  let smsOk    = false;
  let problem  = null;

  // ---- The call and the text --------------------------------
  try {
    // Proof of who is pressing the button. Netlify checks this
    // signature against Google's own keys before it will spend a
    // cent, so a stranger who finds the address can do nothing.
    const token = await auth.currentUser.getIdToken();

    const res = await fetch('/.netlify/functions/notify-technician', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ technicianId: d.techId, zone })
    });

    const out = await res.json();

    if(!res.ok){
      problem = out.error || 'the server refused the request';
    } else {
      calledOk = !!(out.call && out.call.ok);
      smsOk    = !!(out.sms  && out.sms.ok);
      if(!calledOk && out.call) problem = out.call.reason;
      if(!smsOk    && out.sms && !problem) problem = out.sms.reason;
    }
  } catch (err) {
    problem = err.message;
  }

  // ---- The email --------------------------------------------
  //
  // This reuses the fault report template rather than adding a
  // third one, because a dispatch is a fault report addressed to
  // one person, and the free EmailJS plan does not give unlimited
  // templates. The field names below are the ones that template
  // already expects.
  //
  // A failure here never stops the report of the call and the
  // text. Losing the email is a nuisance. Losing the knowledge
  // that the phone rang is not.
  let emailOk = false;

  if(window.emailjs && d.techEmail){
    const level = APP.liveData?.tank?.level != null
      ? Math.round(APP.liveData.tank.level) + '%'
      : 'not stated';

    try {
      await emailjs.send(MAIL.service, MAIL.fault, {
        email:          d.techEmail,
        subject:        `[DISPATCH] ${d.zone || 'Leak'} assigned to you. Aqua Logic`,
        reply_to:       APP.user?.email || '',
        zones:          d.zone || 'Zone unknown',
        datetime:       new Date().toLocaleString('en-ZA'),
        operator:       d.assignedBy || APP.user?.name || 'Control room',
        contact:        APP.user?.phone || '',
        operator_email: APP.user?.email || '',
        assigned:       d.techName || '',
        flow:           `Reservoir level ${level}`,
        details:        `You have been dispatched to ${d.zone || 'a leak'}. `
                      + `Please attend and mark the job complete on the dashboard when done.`
      });
      emailOk = true;
    } catch (err) {
      console.error('Email not sent', err);
    }
  }

  // ---- Tell the operator what actually happened -------------
  // Named individually rather than as a vague "sent", because an
  // operator needs to know whether to pick up the phone themselves.
  const done = [];
  if(calledOk) done.push('called');
  if(smsOk)    done.push('texted');
  if(emailOk)  done.push('emailed');

  const who = (d.techName || 'The technician').split(' ')[0];

  if(done.length){
    showToast(`${who} has been ${done.join(', ')}`,
      problem ? `Not everything went through: ${problem}` : 'The alarm has stopped ringing.');
    logEvent('dispatch', `${d.techName} ${done.join(', ')} for ${d.zone}`, nowTime(), d.zone);
  } else {
    showToast('Nothing was sent', problem || 'Please phone them yourself.');
  }

  if(btn){
    btn.disabled = false;
    btn.textContent = done.length ? '📣 Send again' : '📣 Try again';
  }
}

function setEl(id,val){
  const el = $(id);
  if(el) el.textContent = val;
}
function animateWidth(id,pct){
  const el = $(id);
  if(el) el.style.width = Math.min(100,Math.max(0,Number(pct))) + '%';
}
