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
const AUTHORIZED_USERS = [
  "kledwaba2003@gmail.com",
  "moalosijustice0@gmail.com",
  "hanyanijunior7@gmail.com",
  "edwinskg2004@gmail.com",
  "mtshwenelinda@gmail.com",
  "lucfola@gmail.com",
  "mabasoamile@gmail.com"
];
// ============================================================
// ROLES
// Two kinds of account. The administrator runs the control
// room. Maintenance goes out and fixes the pipe. Both open the
// same dashboard, the role only decides which buttons appear.
//
// Anyone registering picks their own role from the dropdown.
// That is fine for a closed team, because only the email
// addresses in AUTHORIZED_USERS can register at all. If this
// ever goes wider, the role should be set against the email
// beforehand instead of chosen on the form.
// ============================================================
const ROLE_HINTS = {
  admin:       'Administrators see everything and can dispatch, reassign and close jobs.',
  maintenance: 'Maintenance accounts join the call out rotation, so leaks get shared out evenly. You will be called when it is your turn.'
};
function roleHint(){
  const sel = $('rg-role');
  const box = $('roleHintBox');
  if(sel && box) box.textContent = ROLE_HINTS[sel.value] || '';
}
function isAdmin(){
  // Anything that is not explicitly maintenance is treated as an
  // administrator, so accounts made before roles existed still work.
  return (APP.user?.role || 'admin') !== 'maintenance';
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
      <div class="auth-h">Create your account</div>
      <div class="auth-p">Enter your details, then confirm your email address.</div>

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
        <label class="static-label" for="rg-role">I am registering as</label>
        <select id="rg-role" onchange="roleHint()">
          <option value="admin">Administrator. I run the control room</option>
          <option value="maintenance">Maintenance. I go out and fix the leaks</option>
        </select>
      </div>
      <div class="auth-note" id="roleHintBox" style="margin-top:-8px;margin-bottom:18px">
        ${ROLE_HINTS.admin}
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
  const role = ($('rg-role')||{}).value || 'admin';
  // Empty check runs first so a blank form does not show the
  // wrong "not authorised" message.
  if(!name || !surname || !email || !phone || !pass || !conf){
    showToast('⚠ Missing fields', 'Please complete all fields');
    return;
  }
  if(!AUTHORIZED_USERS.includes(email)){
    showToast('🔒 Access Restricted', 'This email address is not authorised to access Aqua Logic systems. Please contact the system administrator.');
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
  APP.pendingReg = { name, surname, email, phone, pass, role };
  APP.emailOTP = genOTP();
  const btn = $('registerBtn');
  setBtnLoading(btn, true, 'Sending code...');
  emailjs.send("service_pljtgtf","template_j20o1f6",{
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
    emailjs.send("service_pljtgtf","template_j20o1f6",{
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
      const uid = cred.user.uid;
      const saves = [
        rtdb.ref('users/' + uid).set({
          name: u.name,
          surname: u.surname,
          email: u.email.toLowerCase(),
          phone: u.phone,
          role: u.role || 'admin',
          createdAt: Date.now()
        })
      ];
      // Registering as maintenance puts you straight into the
      // call out rotation. The team list is built by the people
      // who sign up, not typed in by hand.
      if(u.role === 'maintenance'){
        saves.push(rtdb.ref('team/' + uid).set({
          name: `${u.name} ${u.surname}`.trim(),
          role: 'Maintenance technician',
          phone: u.phone,
          email: u.email.toLowerCase(),
          active: true,
          lastAssignedAt: 0,
          joinedAt: Date.now()
        }));
      }
      return Promise.all(saves);
    })
    .then(() => auth.signOut())
    .then(() => {
      const wasTech = u.role === 'maintenance';
      APP.pendingReg = null;
      showToast('✅ Registration complete',
        wasTech
          ? 'You are on the call out rotation. Please sign in.'
          : 'Please login with your new account');
      APP.authStep = 'login';
      renderAuth();
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
  emailjs.send("service_pljtgtf","template_j20o1f6",{ email: email, otp_code: APP.emailOTP })
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
  if(!AUTHORIZED_USERS.includes(email)){
    showToast('🔒 Unauthorized Access', 'Your account is not approved for Aqua Logic platform access. Please contact your administrator.');
    return;
  }
  const btn = $('loginBtn');
  setBtnLoading(btn, true, 'Checking...');
  let uid = null;
  auth.signInWithEmailAndPassword(email, pass)
    .then(cred => { uid = cred.user.uid; return rtdb.ref('users/' + uid).get(); })
    .then(snap => {
      APP.pendingLogin = Object.assign(
        { name:'Operator', surname:'', email:email, phone:'', role:'admin' },
        snap.val() || {},
        { uid: uid }
      );
      APP.emailOTP = genOTP();
      return emailjs.send("service_pljtgtf","template_j20o1f6",{
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
      console.error(err);
      setBtnLoading(btn, false);
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
  updateTime();
  startIncidentLog();
  renderPressure(null);
  renderFlow(null);
  renderZones({});
  startLiveData();
  startTeam();
  startReports();
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
function openFaultModal(){
  const r = buildFaultReport();
  APP.faultReport = r;
  $('faultEmailBody').textContent =
`To          : everyone with dashboard access (${AUTHORIZED_USERS.length} recipients)
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
  const sends = AUTHORIZED_USERS.map(address =>
    emailjs.send("service_pljtgtf", "template_fault", {
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
  })
  .catch(err=>{
    console.error('Report could not be saved', err);
    setBtnLoading(btn, false);
    showToast('❌ Could not send', 'Check your connection and try again');
  });
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
// >>> PASTE THE REAL TEAM HERE <<<
// Replace the names and numbers below with the real ones. Use
// the international format, +27 then the number without the
// leading zero. This list is only written to the database the
// first time, when /team does not exist yet. After that the
// database copy is what counts, so editing this list later will
// not change anything already saved.
// ============================================================
const TEAM_SEED = [
  { id:'t1', name:'Technician One',   role:'Senior pipe fitter', phone:'+27000000001', active:true, lastAssignedAt:0 },
  { id:'t2', name:'Technician Two',   role:'Pipe fitter',        phone:'+27000000002', active:true, lastAssignedAt:0 },
  { id:'t3', name:'Technician Three', role:'Field assistant',    phone:'+27000000003', active:true, lastAssignedAt:0 },
  { id:'t4', name:'Technician Four',  role:'Standby',            phone:'+27000000004', active:true, lastAssignedAt:0 }
];

let teamRef = null;
let dispatchRef = null;

function startTeam(){
  if(teamRef) return;

  // Write the starting list once, only if the node is empty.
  // Anything already saved is left exactly as it is.
  rtdb.ref('/team').get().then(snap => {
    if(!snap.exists()){
      const seed = {};
      TEAM_SEED.forEach(t => { seed[t.id] = t; });
      return rtdb.ref('/team').set(seed);
    }
  }).catch(err => console.error('Could not check the team list', err));

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
    box.innerHTML = `<div class="empty-state" style="border:none;padding:20px 0">Loading the team list...</div>`;
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
    return `
      <div class="team-row ${isNext ? 'next-up' : ''} ${off ? 'inactive' : ''}">
        <div class="team-avatar">${initials(t.name)}</div>
        <div class="team-info">
          <div class="team-name">${t.name || 'Unnamed'}</div>
          <div class="team-sub">${t.role || 'Technician'} · Last job: ${last}</div>
        </div>
        ${tag}
        <a class="team-call" href="tel:${t.phone || ''}" title="Call ${t.name || ''}">📞</a>
      </div>`;
  }).join('');
}
// Writes the assignment. Two things are saved: the job itself,
// so every dashboard shows it, and the timestamp on the
// technician, which is what moves the rotation along.
function assignTechnician(tech, context){
  const job = {
    techId:    tech.id,
    techName:  tech.name,
    techPhone: tech.phone,
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

  notifyTechnician(tech, job);
  showToast('🔧 Technician assigned', `${tech.name} is on ${job.zone}. Tap the call button to reach them.`);
}
// Called when a sensor leak is confirmed. It only fires once per
// alarm, because renderZones runs several times a second while
// a leak is live.
function autoAssignForLeak(key){
  if(!key || APP.assignedForKey === key) return;
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

  return `
    <div class="dispatch-actions">
      <a class="call-btn" href="tel:${d.techPhone || ''}">📞 Call ${(d.techName || '').split(' ')[0]}</a>
      <a class="sms-btn" href="${smsLink(d.techPhone, jobSmsText(d))}">💬 Send SMS</a>
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
    box.innerHTML = `
      <div class="dispatch-empty">
        No active dispatch. Nothing needs a technician right now.
        ${next ? `<br><br>Next in the rotation is <strong style="color:#00e5a0">${next.name}</strong>.` : ''}
      </div>`;
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
function notifyTechnician(tech, job){
  console.log(`[dispatch] ${tech.name} on ${tech.phone} for ${job.zone}`);
}

function setEl(id,val){
  const el = $(id);
  if(el) el.textContent = val;
}
function animateWidth(id,pct){
  const el = $(id);
  if(el) el.style.width = Math.min(100,Math.max(0,Number(pct))) + '%';
}