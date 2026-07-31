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
  forcedLeakZone: null,
  activeFilter: 'all',
  liveData: null,
  faultReport: null,
  deviceOnline: false,
  liveListenerActive: false
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
  {q:"What happens when a leak is detected?",a:"The affected zone turns into an alert state, an incident is logged, and a fault report can be prepared for the response team."}
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
    <button class="faq-q" onclick="toggleFaq(${i})">
      <span>${f.q}</span><span>▾</span>
    </button>
    <div class="faq-a" id="fa-${i}">
      <p style="padding-top:6px">${f.a}</p>
    </div>
  </div>
`).join('');
function toggleFaq(i){
  const el = $('fa-'+i);
  const open = el.classList.contains('open');
  document.querySelectorAll('.faq-a').forEach(e => e.classList.remove('open'));
  if(!open) el.classList.add('open');
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
  if(s === 'verifyEmail' || s === 'verifyPhone') setupOtpInputs();
}
function loginHTML(){
  return `
    <div style="font-family:var(--font-h);font-size:1.25rem;font-weight:800;margin-bottom:6px">Sign In</div>
    <div style="color:#245;opacity:.85;margin-bottom:14px">Access your water monitoring dashboard</div>
    <div style="display:grid;gap:8px">
      <label style="font-size:.82rem">Email</label>
      <input id="li-email" type="email" placeholder="you@domain.co.za" style="padding:10px;border-radius:8px;border:1px solid #e6f6fb"/>
      <label style="font-size:.82rem">Password</label>
      <div class="pw-wrap">
        <input id="li-pass" type="password" placeholder="••••••"/>
        <button type="button" class="pw-toggle" onclick="toggleEye('li-pass',this)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="ctrl" onclick="startLoginOTP()">Sign In</button>
        <button class="ctrl" onclick="APP.authStep='register';renderAuth()">Register</button>
      </div>
      <div style="margin-top:10px">
        <a href="#" onclick="showForgotPassword()" style="font-size:.85rem;color:#1f6fa8;text-decoration:none;font-weight:700;">Forgot Password?</a>
      </div>
      <div id="otp-section" style="display:none;margin-top:14px">
        <label style="font-size:.82rem">OTP Code</label>
        <input id="li-otp" type="text" placeholder="Enter email OTP" style="padding:10px;border-radius:8px;border:1px solid #e6f6fb"/>
        <button class="ctrl" style="margin-top:10px" onclick="doLogin()">Verify OTP & Sign In</button>
      </div>
    </div>
  `;
}
function registerHTML(){
  return `
    <div style="font-family:var(--font-h);font-size:1.2rem;font-weight:800;margin-bottom:6px">Create Account</div>
    <div style="color:#245;opacity:.85;margin-bottom:10px">Enter your details, then verify your email address.</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <input id="rg-name" placeholder="First name" style="padding:10px;border-radius:8px;border:1px solid #e6f6fb"/>
      <input id="rg-surname" placeholder="Surname" style="padding:10px;border-radius:8px;border:1px solid #e6f6fb"/>
    </div>
    <div style="margin-top:8px">
      <input id="rg-email" type="email" placeholder="you@domain.co.za" style="width:100%;padding:10px;border-radius:8px;border:1px solid #e6f6fb"/>
    </div>
    <div style="margin-top:8px">
      <input id="rg-phone" type="tel" placeholder="0821234567 or +27821234567" style="width:100%;padding:10px;border-radius:8px;border:1px solid #e6f6fb"/>
    </div>
    <div style="margin-top:10px">
      <label style="font-size:.82rem;font-weight:700;color:#245;display:block;margin-bottom:4px">Password</label>
      <div class="pw-wrap">
        <input id="rg-pass" type="password" placeholder="Create a strong password" oninput="updatePwFeedback(this.value,'pwStrBar','pwStrLbl','pwReqsList');checkConfirm();"/>
        <button type="button" class="pw-toggle" onclick="toggleEye('rg-pass',this)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <div class="pw-strength-bar" id="pwStrBar"><span></span><span></span><span></span><span></span></div>
      <div class="pw-strength-label" id="pwStrLbl"></div>
      <div class="pw-reqs" id="pwReqsList">
        ${PW_RULES.map(r=>`<div class="pw-req"><div class="req-dot">✓</div><span>${r.label}</span></div>`).join('')}
      </div>
    </div>
    <div style="margin-top:10px">
      <label style="font-size:.82rem;font-weight:700;color:#245;display:block;margin-bottom:4px">Confirm Password</label>
      <div class="pw-wrap">
        <input id="rg-conf" type="password" placeholder="Repeat your password" oninput="checkConfirm()"/>
        <button type="button" class="pw-toggle" onclick="toggleEye('rg-conf',this)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <div id="matchMsg" style="font-size:.76rem;margin-top:4px;height:14px;font-weight:700"></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="ctrl" onclick="doRegister()">Next: Verify Email</button>
      <button class="ctrl" onclick="APP.authStep='login';renderAuth()">Back</button>
    </div>`;
}
function verifyEmailHTML(){
  return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
      <div style="font-size:1rem;font-weight:800">Verify Email</div>
      <div style="color:#3a6a7a">Code sent to <strong>${APP.pendingReg?.email || '—'}</strong></div>
      <div style="background:rgba(0,172,193,0.06);padding:8px;border-radius:8px;font-family:var(--font-m)">Enter the 6 digit code from your email</div>
      <div id="otpEmail" style="display:flex;gap:8px;margin-top:8px">
        ${Array(6).fill(0).map(()=>'<input maxlength="1" inputmode="numeric" style="width:40px;padding:10px;text-align:center;border-radius:6px;border:1px solid #e6f6fb">').join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="ctrl" onclick="verifyEmail()">Verify Email</button>
        <button class="ctrl" onclick="resendOtp('email')">Resend</button>
      </div>
    </div>`;
}
function verifyPhoneHTML(){
  return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
      <div style="font-size:1rem;font-weight:800">Verify Phone Number</div>
      <div style="color:#3a6a7a">SMS code will be sent to <strong>${APP.pendingReg?.phone || '—'}</strong></div>
      <div style="background:rgba(0,172,193,0.06);padding:8px;border-radius:8px;font-family:var(--font-m)">Complete reCAPTCHA, then enter the 6 digit SMS code</div>
      <div id="otpSms" style="display:flex;gap:8px;margin-top:8px">
        ${Array(6).fill(0).map(()=>'<input maxlength="1" inputmode="numeric" style="width:40px;padding:10px;text-align:center;border-radius:6px;border:1px solid #e6f6fb">').join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="ctrl" onclick="sendPhoneOtp()">Send SMS Code</button>
        <button class="ctrl" onclick="verifyPhone()">Verify Phone</button>
      </div>
    </div>`;
}
function forgotEmailHTML(){
  return `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="font-family:var(--font-h);font-size:1.2rem;font-weight:800">Forgot Password</div>
      <div style="color:#456">Enter your registered email. Firebase will send you a reset link that works on any device.</div>
      <input id="fp-email" type="email" placeholder="you@domain.co.za" style="padding:10px;border-radius:8px;border:1px solid #e6f6fb"/>
      <button class="ctrl" onclick="sendResetOTP()">Send Reset Link</button>
      <button class="ctrl" onclick="APP.authStep='login';renderAuth()">Back To Sign In</button>
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
    msg.style.color = '#00b86b';
  } else {
    msg.textContent = '✗ Passwords do not match';
    msg.style.color = '#f44336';
  }
}
function setupOtpInputs(){
  const inputs = document.querySelectorAll('.auth-panel input[maxlength="1"]');
  inputs.forEach((inp,i)=>{
    inp.addEventListener('input',()=>{
      inp.value = inp.value.replace(/\D/g,'');
      if(inp.value && inputs[i+1]) inputs[i+1].focus();
    });
    inp.addEventListener('keydown',e=>{
      if(e.key === 'Backspace' && !inp.value && inputs[i-1]) inputs[i-1].focus();
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
  APP.pendingReg = { name, surname, email, phone, pass };
  APP.emailOTP = genOTP();
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
      return rtdb.ref('users/' + cred.user.uid).set({
        name: u.name,
        surname: u.surname,
        email: u.email.toLowerCase(),
        phone: u.phone,
        createdAt: Date.now()
      });
    })
    .then(() => auth.signOut())
    .then(() => {
      APP.pendingReg = null;
      showToast('✅ Registration complete', 'Please login with your new account');
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
  const otp = ($('li-otp')||{}).value?.trim();
  if(!otp){
    showToast('⚠ Missing OTP', 'Enter the code sent to your email');
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
  auth.sendPasswordResetEmail(email)
    .then(() => {
      showToast('📧 Reset link sent', 'Check your email and follow the link');
      APP.authStep = 'login';
      renderAuth();
    })
    .catch(err => {
      console.error(err);
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
  auth.signInWithEmailAndPassword(email, pass)
    .then(cred => rtdb.ref('users/' + cred.user.uid).get())
    .then(snap => {
      APP.pendingLogin = snap.val() || { name:'Operator', surname:'', email:email, phone:'' };
      APP.emailOTP = genOTP();
      return emailjs.send("service_pljtgtf","template_j20o1f6",{
        email: email,
        otp_code: APP.emailOTP
      });
    })
    .then(() => {
      $('otp-section').style.display = 'block';
      showToast('📧 OTP sent', 'Check your email');
    })
    .catch(err => {
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
  updateTime();
  seedHistory();
  renderPressure(null);
  renderFlow(null);
  renderZones({});
  startLiveData();
}
function logout(){
  auth.signOut().catch(err => console.error(err));
  APP.user = null;
  APP.pendingLogin = null;
  APP.incidentLog = [];
  APP.leakZones = [];
  APP.forcedLeakZone = null;
  APP.liveData = null;
  $('dashboard').style.display = 'none';
  $('publicSite').style.display = 'block';
  $('dashboard').setAttribute('aria-hidden','true');
  stopLiveData();
  showToast('👋 Logged out', 'You have been signed out');
}
function updateTime(){
  $('dashTime').textContent = 'Last refreshed: ' + new Date().toLocaleString('en-ZA',{dateStyle:'medium',timeStyle:'short'});
}

// ============================================================
// REAL TIME DATA
// The ESP32 writes readings to /aqualogic in the Realtime
// Database every 2 seconds. This listener fires on every write,
// so the dashboard updates live with no polling.
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
    const forced = APP.forcedLeakZone === z.id;
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
    const key = APP.leakZones.join(',');
    if(!APP.escalationsSent[key] || (Date.now()-APP.escalationsSent[key] > 120000)){
      APP.escalationsSent[key] = Date.now();
      openFaultModal();
      const t = new Date().toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit'});
      APP.leakZones.forEach(zid => logEvent('leak', `Zone ${zid}: Leak detected`, t, `Zone ${zid}`));
    }
  } else if(APP.deviceOnline){
    setSystemStatus('green', 'ALL SYSTEMS NOMINAL');
  }
}

// ============================================================
// INCIDENT HISTORY
// ============================================================
function seedHistory(){
  APP.incidentLog = [
    {type:'system',msg:'Dashboard connected. Waiting for device data',time: new Date().toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit'}),zone:'System'}
  ];
  renderHistoryBody('all');
}
function logEvent(type,msg,time,zone){
  APP.incidentLog.unshift({type,msg,time,zone});
  if(APP.incidentLog.length>120) APP.incidentLog.pop();
  renderHistoryBody(APP.activeFilter || 'all');
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
  const icons={leak:'🔴',normal:'🟢',email:'📧',system:'⚙️'};
  const filtered = (!filter || filter==='all') ? APP.incidentLog : APP.incidentLog.filter(e=>e.type===filter);
  const body = $('historyBody');
  body.innerHTML = filtered.length
    ? filtered.map(e=>`
      <div class="h-item">
        <div class="h-item-icon" style="background:${e.type==='leak'?'#ffecec':e.type==='normal'?'#f0fff4':'#f0fbff'}">${icons[e.type]||'ℹ️'}</div>
        <div>
          <div class="h-item-title">${e.msg}</div>
          <div class="h-item-meta"><span>🕐 ${e.time}</span><span>📍 ${e.zone||'System'}</span></div>
        </div>
      </div>
    `).join('')
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
  return {
    zones: zones,
    datetime: new Date().toLocaleString('en-ZA', { dateStyle:'full', timeStyle:'short' }),
    operator: `${u.name || 'System'} ${u.surname || ''}`.trim(),
    contact: u.phone || 'Not provided',
    operator_email: u.email || 'system@aqualogic.co.za',
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
`To          : support@ujaqualogic.co.za
From        : ${r.operator_email}
Subject     : [URGENT] Water Leak Detected. ${r.zones}
INCIDENT REPORT
Date and time : ${r.datetime}
Affected zones: ${r.zones}
Alert level   : High priority
Operator      : ${r.operator}
Contact       : ${r.contact}
ANOMALY DETAILS
${r.details}
WATER BALANCE
${r.flow}
Please dispatch a response team to the affected zone as soon as possible.
Aqua Logic Monitoring System`;
  $('faultModal').classList.add('show');
  $('faultModal').setAttribute('aria-hidden','false');
}
function closeFault(){
  $('faultModal').classList.remove('show');
  $('faultModal').setAttribute('aria-hidden','true');
}
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
  emailjs.send("service_pljtgtf", "template_fault", {
    email:          "support@ujaqualogic.co.za",
    subject:        `[URGENT] Water Leak Detected. ${r.zones}. Aqua Logic`,
    reply_to:       r.operator_email,
    zones:          r.zones,
    datetime:       r.datetime,
    operator:       r.operator,
    contact:        r.contact,
    operator_email: r.operator_email,
    flow:           r.flow,
    details:        r.details
  })
  .then(() => {
    APP.lastEmailSentAt = Date.now();
    logEvent('email',
      `Fault report sent to support@ujaqualogic.co.za for ${r.zones}`,
      new Date().toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit'}),
      'System');
    closeFault();
    showToast('📧 Report sent', 'The response team has been notified');
  })
  .catch(err => {
    console.error(err);
    showToast('❌ Report failed', 'Could not send. Check your connection and try again.');
  })
  .finally(() => {
    btn.disabled = false;
    btn.textContent = 'Send Report';
  });
}
function acknowledge(zone){
  logEvent('system',`Zone ${zone}: Incident acknowledged by operator`,new Date().toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit'}),`Zone ${zone}`);
  showToast('📝 Acknowledged', `Zone ${zone} acknowledged`);
  if(APP.forcedLeakZone===zone) APP.forcedLeakZone=null;
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
function setEl(id,val){
  const el = $(id);
  if(el) el.textContent = val;
}
function animateWidth(id,pct){
  setTimeout(()=>{
    const el = $(id);
    if(el) el.style.width = Math.min(100,Math.max(0,Number(pct))) + '%';
  },30);
}
