'use strict';

// ── Konstanten ────────────────────────────────────────────────────────────────
const MAX_TEXT_LEN   = 4000;
const MAX_IMG_BYTES  = 1 * 1024 * 1024;   // 1MB — stabiler auf Mobile
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const IMG_MAX_DIM    = 1280;
const IMG_QUALITY    = 0.78;
const WS_PROTO       = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ROOM_LIFETIME  = 2 * 60 * 60 * 1000;
const KEEPALIVE_MS   = 15 * 1000;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
const REACTIONS      = ['👍','❤️','😂','😮','😢','🔥'];
const EDIT_WINDOW_MS = 30 * 1000;
const VIDEO_MAX_SEC  = 60;

// ── State ─────────────────────────────────────────────────────────────────────
let cryptoKey = null, ws = null, roomId = null;
let partnerConnected = false, intentionalClose = false;
let countdownInterval = null, keepaliveTimer = null, reconnectTimer = null;
let reconnectAttempts = 0, typingTimer = null, typingActive = false;
let pendingPwHash = null, fontSize = 16, pendingRoomLink = null;
let mediaRecorder = null, audioChunks = [], recInterval = null, recSeconds = 0;
let videoRecorder = null, videoChunks = [], videoRecInterval = null, videoRecSeconds = 0;
let pendingMediaData = null, pendingMediaMime = null, pendingMediaType = null;
let replyToId = null, replyToText = null, editingId = null;
let sdTextEnabled = false, unread = 0, roomExpiry = null;
let hasShownNewMsgDivider = false;
const myMsgs  = new Map();
const sdTimers = new Map();

// ── WebRTC State ──────────────────────────────────────────────────────────────
let peerConn              = null;
let localStream           = null;
let callTimer             = null;
let callSeconds           = 0;
let isMuted               = false;
let iceServers            = null;
let callReconnectAttempts = 0;
let pendingIceCandidates  = [];

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screens = { home:$('screen-home'), share:$('screen-share'), pw:$('screen-pw'), chat:$('screen-chat'), closed:$('screen-closed') };
function showScreen(n) {
  for (const [k,el] of Object.entries(screens)) el.classList.toggle('active', k===n);
  if (n !== 'chat') window.scrollTo(0,0);
}

// ══════════════════════════════════════════════════════════════════════════════
// ANTI-SCREENSHOT SCHUTZ
// ══════════════════════════════════════════════════════════════════════════════

// ── Wasserzeichen ─────────────────────────────────────────────────────────────
function initWatermark() {
  const canvas = $('watermark-canvas');
  if (!canvas) return;
  function draw() {
    const ctx = canvas.getContext('2d');
    const p   = canvas.parentElement;
    canvas.width  = p.offsetWidth;
    canvas.height = p.offsetHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.globalAlpha = 0.045;
    ctx.fillStyle   = '#00ff41';
    ctx.font        = '12px monospace';
    ctx.translate(canvas.width/2, canvas.height/2);
    ctx.rotate(-28 * Math.PI / 180);
    const text = `ephemera · ${new Date().toLocaleDateString('de-DE')} · VERTRAULICH`;
    for (let y = -canvas.height; y < canvas.height; y += 110) {
      for (let x = -canvas.width; x < canvas.width; x += 190) {
        ctx.fillText(text, x, y);
      }
    }
    ctx.restore();
  }
  draw();
  new ResizeObserver(draw).observe(canvas.parentElement);
  setInterval(draw, 60000);
}

// ── Shield — Chat wird schwarz wenn Tab verlassen ─────────────────────────────
let shieldActive = false;

function activateShield() {
  if (shieldActive) return;
  shieldActive = true;
  const shield = $('screenshot-shield');
  if (shield) shield.style.display = 'flex';
  const wrap = $('messages-wrap');
  if (wrap) wrap.style.filter = 'blur(20px) brightness(0)';
  const overlay = $('video-call-overlay');
  if (overlay && overlay.style.display !== 'none') {
    overlay.classList.add('blurred');
    let vs = overlay.querySelector('.video-shield');
    if (!vs) {
      vs = document.createElement('div'); vs.className = 'video-shield';
      vs.innerHTML = '<div class="shield-icon">🔒</div><div class="video-shield-text">VIDEO AUSGEBLENDET</div>';
      overlay.appendChild(vs);
    }
    vs.style.display = 'flex';
  }
}

function deactivateShield() {
  if (!shieldActive) return;
  shieldActive = false;
  const shield = $('screenshot-shield');
  if (shield) shield.style.display = 'none';
  const wrap = $('messages-wrap');
  if (wrap) wrap.style.filter = '';
  const overlay = $('video-call-overlay');
  if (overlay) {
    overlay.classList.remove('blurred');
    const vs = overlay.querySelector('.video-shield');
    if (vs) vs.style.display = 'none';
  }
}

// Tab verlassen / Bildschirm sperren
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') activateShield();
  else setTimeout(deactivateShield, 300);
});

// window.blur fängt Screenshot-Shortcuts ab (Handy-Buttons, Tastenkürzel)
// Kurze Verzögerung damit echte Wechsel erkannt werden, aber Screenshot-Moment geschützt ist
window.addEventListener('blur', () => {
  if (screens.chat?.classList.contains('active') || $('video-call-overlay')?.style.display !== 'none') {
    activateShield();
  }
});
window.addEventListener('focus', () => setTimeout(deactivateShield, 300));
window.addEventListener('beforeprint', activateShield);
window.addEventListener('afterprint',  deactivateShield);

// Android: Screenshot-Button löst oft kurzen Helligkeitswechsel aus
// Wir können das nicht direkt erkennen, aber blur+focus Kombination hilft
// iOS: Kein Weg — Power+Lautstärke geht am Browser vorbei

// CSS Print-Schutz
const printStyle = document.createElement('style');
printStyle.textContent = `@media print {
  #screen-chat, #messages-wrap, #video-call-overlay { visibility:hidden!important; filter:blur(999px)!important; }
  body::after { content:"Dieser Inhalt ist geschützt."; display:block; font-size:2rem; text-align:center; padding:4rem; visibility:visible!important; }
}`;
document.head.appendChild(printStyle);

// ── Audio-Ausgabe ─────────────────────────────────────────────────────────────
let currentSinkId = '';

async function initAudioOutput() {
  const btn = $('btn-audio-output');
  if (!btn) return;
  const remoteAudio = $('remote-audio');
  if (!remoteAudio?.setSinkId) {
    btn.title = 'Ausgabewahl nicht verfügbar auf diesem Gerät (iOS)';
    btn.style.opacity = '0.4'; btn.style.cursor = 'not-allowed'; return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const headset = devices.filter(d=>d.kind==='audiooutput').find(d=>
      /headset|bluetooth|airpod|wireless/i.test(d.label)
    );
    if (headset) {
      const el = $('output-headset');
      if (el) { el.style.display='flex'; el.dataset.sink=headset.deviceId; el.textContent=`🎧 ${headset.label||'Headset'}`; }
    }
  } catch {}

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const p = $('audio-output-picker');
    if (p) p.style.display = p.style.display==='block' ? 'none' : 'block';
  });

  $('audio-output-picker')?.querySelectorAll('.output-option').forEach(opt => {
    opt.addEventListener('click', async () => {
      const sinkId = opt.dataset.sink || '';
      try {
        await remoteAudio.setSinkId(sinkId);
        currentSinkId = sinkId;
        $('audio-output-picker').querySelectorAll('.output-option').forEach(o=>o.classList.remove('active'));
        opt.classList.add('active');
        btn.textContent = sinkId===''?'📱':'🔊';
        addSystem('// Audioausgabe: '+opt.textContent.trim());
      } catch(e) { addSystem('[Ausgabewechsel nicht möglich: '+e.message+']'); }
      $('audio-output-picker').style.display='none';
    });
  });

  document.addEventListener('click', e => {
    const p = $('audio-output-picker');
    if (p && !p.contains(e.target) && e.target!==btn) p.style.display='none';
  });
}

// ── Matrix ────────────────────────────────────────────────────────────────────
function initMatrix() {
  // Routine aus dem abgenommenen Entwurf: je Spalte ein heller Kopf und ein
  // nachlaufendes Zeichen darüber. Die alte Fassung malte nur ein gedämpftes
  // Zeichen — bei 26 % Deckkraft und der Vignette blieb davon nichts sichtbar
  // (gemessen: 0,21 % helle Pixel auf der abgetasteten Fläche).
  const canvas = $('matrix-canvas'), ctx = canvas.getContext('2d');
  const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎ0123456789ABCDEF';
  const CW = 15;
  let cols = [];
  const fit = () => {
    canvas.width = innerWidth; canvas.height = innerHeight;
    cols = [];
    for (let i = 0; i < Math.ceil(canvas.width / CW); i++) cols.push(Math.random() * -canvas.height);
  };
  const glyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  function draw() {
    ctx.fillStyle = 'rgba(3,6,3,.085)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '14px "Share Tech Mono", monospace';
    for (let i = 0; i < cols.length; i++) {
      const x = i * CW, y = cols[i];
      ctx.fillStyle = '#8dff7e'; ctx.fillText(glyph(), x, y);
      ctx.fillStyle = '#2be820'; ctx.fillText(glyph(), x, y - 16);
      cols[i] = y > canvas.height + Math.random() * 900 ? 0 : y + 16;
    }
  }
  addEventListener('resize', fit);
  fit();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) draw();
  else setInterval(draw, 62);
}
initMatrix();

// ── Krypto ────────────────────────────────────────────────────────────────────
async function generateKey() {
  const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  const raw = await crypto.subtle.exportKey('raw',key);
  const b64url = btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return {key,b64url};
}
async function importKey(b64url) {
  const raw = Uint8Array.from(atob(b64url.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
  return crypto.subtle.importKey('raw',raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
// String.fromCharCode(...buf) legt jedes Byte als eigenes Argument auf den
// Aufrufstapel. Ab etwa 100 KB kippt das mit "Maximum call stack size
// exceeded" — dadurch scheiterte jede Sprachnachricht und jedes groessere
// Bild. In Bloecken umgewandelt gibt es diese Grenze nicht.
function bytesZuBase64(bytes) {
  let aus = '';
  const BLOCK = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOCK) {
    aus += String.fromCharCode.apply(null, bytes.subarray(i, i + BLOCK));
  }
  return btoa(aus);
}

async function encrypt(plaintext) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},cryptoKey,new TextEncoder().encode(plaintext));
  const buf=new Uint8Array(12+ct.byteLength); buf.set(iv); buf.set(new Uint8Array(ct),12);
  return bytesZuBase64(buf);
}
async function decrypt(b64) {
  const buf=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:buf.slice(0,12)},cryptoKey,buf.slice(12));
  return new TextDecoder().decode(pt);
}
async function hashPassword(pw) {
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ── Session Token — verhindert doppelte Verbindungen ──────────────────────────
// Bleibt im Tab, wird bei jedem Reconnect mitgeschickt
// Server erkennt: gleicher Token = Reconnect → alte Verbindung ersetzen
function getSessionToken() {
  let token = sessionStorage.getItem('ephemera_token');
  if (!token) {
    token = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('ephemera_token', token);
  }
  return token;
}
function getSupportedAudioMime() {
  const types = ['audio/mp4','audio/aac','audio/webm;codecs=opus','audio/webm','audio/ogg'];
  for (const t of types) { if (MediaRecorder.isTypeSupported(t)) return t; }
  return '';
}
function getSupportedVideoMime() {
  const types = ['video/mp4','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
  for (const t of types) { if (MediaRecorder.isTypeSupported(t)) return t; }
  return '';
}

// ── Passwort-Stärke ───────────────────────────────────────────────────────────
$('pw-input').addEventListener('input', function() {
  const pw=this.value; let s=0;
  if(pw.length>6)s++;if(pw.length>10)s++;if(/[A-Z]/.test(pw))s++;if(/[0-9]/.test(pw))s++;if(/[^a-zA-Z0-9]/.test(pw))s++;
  const fill=$('pw-strength-fill'); fill.style.width=(s/5*100)+'%';
  fill.style.background=['','#ff3333','#ff8800','#ffcc00','#88cc00','#00ff41'][s]||'';
});
[['pw-input','pw-toggle'],['pw-join','pw-join-toggle']].forEach(([inp,btn])=>{
  $(btn).addEventListener('click',()=>{const el=$(inp);el.type=el.type==='password'?'text':'password';});
});

// ── Bild komprimieren ─────────────────────────────────────────────────────────
async function compressImage(file) {
  return new Promise((resolve,reject) => {
    const reader=new FileReader();
    reader.onload=e=>{
      const img=new Image();
      img.onload=()=>{
        let{width:w,height:h}=img;
        if(w>IMG_MAX_DIM||h>IMG_MAX_DIM){const r=Math.min(IMG_MAX_DIM/w,IMG_MAX_DIM/h);w=Math.round(w*r);h=Math.round(h*r);}
        const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h;
        canvas.getContext('2d').drawImage(img,0,0,w,h);
        let q=IMG_QUALITY;
        const tryC=()=>canvas.toBlob(blob=>{
          if(!blob){reject(new Error('Komprimierung fehlgeschlagen'));return;}
          if(blob.size<=MAX_IMG_BYTES||q<0.25){
            const r2=new FileReader(); r2.onload=ev=>resolve({dataUrl:ev.target.result,mime:blob.type,size:blob.size}); r2.readAsDataURL(blob);
          }else{q-=0.08;tryC();}
        },'image/jpeg',q);
        tryC();
      };
      img.onerror=reject; img.src=e.target.result;
    };
    reader.onerror=reject; reader.readAsDataURL(file);
  });
}

// ── Sound ─────────────────────────────────────────────────────────────────────
function playPing() {
  try {
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.connect(gain);gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(1100,ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(550,ctx.currentTime+0.1);
    gain.gain.setValueAtTime(0.1,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.18);
    osc.start();osc.stop(ctx.currentTime+0.18);
  }catch{}
}

// ── Klingelton ────────────────────────────────────────────────────────────────

function playRingtone() {
  stopRingtone(); // Sicherstellen dass kein alter läuft
  try {
    _ringCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ring = () => {
      if (!_ringCtx) return;
      try {
        // Zwei Töne für realistischeren Klingelton
        [[880, 0, 0.15], [660, 0.2, 0.15]].forEach(([freq, delay, dur]) => {
          const osc  = _ringCtx.createOscillator();
          const gain = _ringCtx.createGain();
          osc.connect(gain); gain.connect(_ringCtx.destination);
          osc.frequency.setValueAtTime(freq, _ringCtx.currentTime + delay);
          gain.gain.setValueAtTime(0.25, _ringCtx.currentTime + delay);
          gain.gain.exponentialRampToValueAtTime(0.001, _ringCtx.currentTime + delay + dur);
          osc.start(_ringCtx.currentTime + delay);
          osc.stop(_ringCtx.currentTime + delay + dur);
        });
      } catch {}
    };
    ring();
    _ringInterval = setInterval(ring, 1500);
  } catch {}
}

function stopRingtone() {
  clearInterval(_ringInterval); _ringInterval = null;
  if (_ringCtx) {
    try { _ringCtx.close(); } catch {}
    _ringCtx = null;
  }
}
function vibrate(pattern=[80]){try{navigator.vibrate?.(pattern);}catch{}}

// ── Tab Badge ─────────────────────────────────────────────────────────────────
function bumpUnread(){if(document.visibilityState==='visible')return;unread++;document.title=`(${unread}) ephemera`;}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){unread=0;document.title='ephemera';}});

// ── Countdown ─────────────────────────────────────────────────────────────────
function startCountdown(createdAt) {
  roomExpiry=createdAt+ROOM_LIFETIME; $('countdown-wrap').style.display='flex';
  const tick=()=>{
    const rem=roomExpiry-Date.now();
    if(rem<=0){$('countdown').textContent='0:00:00';return;}
    const h=Math.floor(rem/3600000),m=Math.floor(rem%3600000/60000),s=Math.floor(rem%60000/1000);
    $('countdown').textContent=`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    const el=$('countdown');el.className='countdown-val';
    if(rem<10*60000)el.classList.add('critical');else if(rem<30*60000)el.classList.add('warning');
  };
  tick();countdownInterval=setInterval(tick,1000);
}

// ── QR ────────────────────────────────────────────────────────────────────────
function showQR(link){
  $('qr-canvas').innerHTML='';
  new QRCode($('qr-canvas'),{text:link,width:200,height:200,colorDark:'#00ff41',colorLight:'#0a0f0a',correctLevel:QRCode.CorrectLevel.M});
  $('qr-overlay').style.display='flex';
}
$('btn-qr-close').addEventListener('click',()=>$('qr-overlay').style.display='none');
$('btn-fs-close').addEventListener('click',()=>$('media-fullscreen').style.display='none');
function openFullscreen(type,src){
  $('fs-img').style.display='none';$('fs-vid').style.display='none';
  if(type==='img'){$('fs-img').src=src;$('fs-img').style.display='block';}
  else{$('fs-vid').src=src;$('fs-vid').style.display='block';}
  $('media-fullscreen').style.display='flex';
}

// ── Keepalive ─────────────────────────────────────────────────────────────────
function startKeepalive(){clearInterval(keepaliveTimer);keepaliveTimer=setInterval(()=>{if(ws?.readyState===1)ws.send(JSON.stringify({type:'ping'}));},KEEPALIVE_MS);}
function stopKeepalive(){clearInterval(keepaliveTimer);}

// ── Reconnect ─────────────────────────────────────────────────────────────────
function scheduleReconnect(){
  if(intentionalClose)return;
  if(reconnectAttempts>=RECONNECT_DELAYS.length)reconnectAttempts=RECONNECT_DELAYS.length-1;
  const delay=RECONNECT_DELAYS[reconnectAttempts++];
  const b=$('reconnect-banner');b.className='visible';
  b.textContent=`> VERBINDUNG GETRENNT — Wiederverbindung in ${Math.round(delay/1000)}s …`;
  reconnectTimer=setTimeout(()=>{if(!intentionalClose&&roomId&&cryptoKey){b.textContent='> VERBINDE …';openWebSocket();}},delay);
}
function cancelReconnect(){clearTimeout(reconnectTimer);$('reconnect-banner').className='';}

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&roomId&&cryptoKey&&!intentionalClose){
    if(!ws||ws.readyState===WebSocket.CLOSED||ws.readyState===WebSocket.CLOSING){cancelReconnect();reconnectAttempts=0;openWebSocket();}
  }
});
window.addEventListener('online',()=>{
  if(roomId&&cryptoKey&&!intentionalClose&&(!ws||ws.readyState===WebSocket.CLOSED)){cancelReconnect();reconnectAttempts=0;openWebSocket();}
});

// ── Drag & Drop ───────────────────────────────────────────────────────────────
const dropOverlay=$('drop-overlay');
dropOverlay.textContent='> DATEI HIER ABLEGEN';
document.addEventListener('dragover',e=>{e.preventDefault();dropOverlay.classList.add('visible');});
document.addEventListener('dragleave',e=>{if(!e.relatedTarget)dropOverlay.classList.remove('visible');});
document.addEventListener('drop',async e=>{e.preventDefault();dropOverlay.classList.remove('visible');for(const f of[...(e.dataTransfer?.files||[])])await handleFileOrImage(f);});

// ── Scroll ────────────────────────────────────────────────────────────────────
function scrollMsgs(){const w=$('messages-wrap');if(w)w.scrollTop=w.scrollHeight;}

// ── Partner Banner ────────────────────────────────────────────────────────────
function setPartnerBanner(state){
  let b=$('partner-banner');
  if(!b){b=document.createElement('div');b.id='partner-banner';$('messages').insertBefore(b,$('messages').firstChild);}
  b.className=`partner-banner ${state}`;b.style.display=state==='hidden'?'none':'block';
  b.textContent=state==='online'?'> GESPRÄCHSPARTNER ONLINE':'> GESPRÄCHSPARTNER OFFLINE';
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(state,text){$('status-cursor').className='cursor-blink '+state;$('status-text').textContent=text;}
function enableInput(yes){$('msg-input').disabled=!yes;$('btn-send').disabled=!yes;if(yes)$('msg-input').focus();}

// ── Emoji Picker ──────────────────────────────────────────────────────────────
function showEmojiPicker(msgId,anchor){
  const picker=$('emoji-picker'),list=$('emoji-list');list.innerHTML='';
  REACTIONS.forEach(emoji=>{
    const btn=document.createElement('button');btn.className='emoji-opt';btn.textContent=emoji;
    btn.addEventListener('click',()=>{sendReaction(msgId,emoji);picker.style.display='none';});list.appendChild(btn);
  });
  const rect=anchor.getBoundingClientRect();
  picker.style.bottom=(window.innerHeight-rect.top+4)+'px';
  picker.style.left=Math.max(4,Math.min(rect.left,window.innerWidth-210))+'px';
  picker.style.top='auto';picker.style.display='block';
}
document.addEventListener('click',e=>{if(!$('emoji-picker').contains(e.target))$('emoji-picker').style.display='none';});

// ── Neue Nachrichten Trennlinie ───────────────────────────────────────────────
function insertNewMsgDivider(){
  if(hasShownNewMsgDivider)return;hasShownNewMsgDivider=true;
  const div=document.createElement('div');div.className='new-msg-divider msg system';div.textContent='NEUE NACHRICHTEN';
  $('messages').appendChild(div);
}

// ── Nachricht bauen ───────────────────────────────────────────────────────────
function newMsgId(){return crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);}
function fmtTime(ts){const d=new Date(ts||Date.now());return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');}

function buildBubble(role,id){
  const wrap=document.createElement('div');wrap.className=`msg ${role}`;if(id)wrap.dataset.id=id;
  const actions=document.createElement('div');actions.className='msg-actions';
  const replyBtn=document.createElement('button');replyBtn.className='msg-action-btn';replyBtn.textContent='↩';
  replyBtn.addEventListener('click',()=>startReply(id,wrap));actions.appendChild(replyBtn);
  const reactBtn=document.createElement('button');reactBtn.className='msg-action-btn';reactBtn.textContent='😊';
  reactBtn.addEventListener('click',e=>{e.stopPropagation();showEmojiPicker(id,reactBtn);});actions.appendChild(reactBtn);
  wrap.appendChild(actions);return wrap;
}

function addMeta(wrap,role,id,ts,isPending){
  const meta=document.createElement('div');meta.className='msg-meta';
  const time=document.createElement('span');time.className='msg-time';time.textContent=fmtTime(ts);meta.appendChild(time);
  if(role==='self'&&id){
    const readEl=document.createElement('span');
    readEl.className=isPending?'read-status read-pending':'read-status';
    readEl.textContent=isPending?'⏳':'✓';meta.appendChild(readEl);
    myMsgs.set(id,{el:wrap,readEl});
    const ret=document.createElement('button');ret.className='btn-retract';ret.textContent='zurückziehen';
    ret.addEventListener('click',()=>retractMessage(id));meta.appendChild(ret);
    const editBtn=document.createElement('button');editBtn.className='btn-edit';editBtn.textContent='✎';
    editBtn.addEventListener('click',()=>{const t=wrap.querySelector('.msg-text');if(t)startEdit(id,t.textContent);});meta.appendChild(editBtn);
  }
  const reacDiv=document.createElement('div');reacDiv.className='msg-reactions';reacDiv.id=`reactions-${id}`;
  wrap.appendChild(meta);wrap.appendChild(reacDiv);return meta;
}

function addTextMessage(text,role,id,ts,isPending,quoteId,quoteText,edited){
  const wrap=buildBubble(role,id);
  if(quoteText){const q=document.createElement('div');q.className='msg-quote';q.textContent=quoteText.slice(0,80)+(quoteText.length>80?'…':'');wrap.appendChild(q);}
  const body=document.createElement('div');body.className='msg-body';
  const t=document.createElement('span');t.className='msg-text';t.textContent=text;body.appendChild(t);wrap.appendChild(body);
  const meta=addMeta(wrap,role,id,ts,isPending);
  if(edited){const ed=document.createElement('span');ed.className='edited-label';ed.textContent='(bearbeitet)';meta.prepend(ed);}
  $('messages').appendChild(wrap);scrollMsgs();
  if(role==='other'&&id&&ws?.readyState===1)ws.send(JSON.stringify({type:'read',id}));
  return wrap;
}

function addImageMessage(dataUrl,role,id,ts,isPending){
  const wrap=buildBubble(role,id);
  const img=document.createElement('img');img.className='msg-img';img.src=dataUrl;img.alt='Bild';
  img.addEventListener('click',()=>openFullscreen('img',dataUrl));wrap.appendChild(img);
  addMeta(wrap,role,id,ts,isPending);$('messages').appendChild(wrap);scrollMsgs();
  if(role==='other'&&id&&ws?.readyState===1)ws.send(JSON.stringify({type:'read',id}));
  return wrap;
}

function addVideoMessage(dataUrl,role,id,ts,isPending){
  const wrap=buildBubble(role,id);
  const vid=document.createElement('video');vid.className='msg-vid';vid.src=dataUrl;vid.controls=true;vid.preload='metadata';
  vid.addEventListener('dblclick',()=>openFullscreen('vid',dataUrl));wrap.appendChild(vid);
  addMeta(wrap,role,id,ts,isPending);$('messages').appendChild(wrap);scrollMsgs();
  if(role==='other'&&id&&ws?.readyState===1)ws.send(JSON.stringify({type:'read',id}));
  return wrap;
}

function addAudioMessage(dataUrl,role,id,ts,isPending){
  const wrap=buildBubble(role,id);
  const div=document.createElement('div');div.className='msg-audio';
  const lbl=document.createElement('div');lbl.className='audio-label';lbl.textContent='> SPRACHNACHRICHT';
  const aud=document.createElement('audio');aud.controls=true;aud.src=dataUrl;aud.preload='metadata';
  div.appendChild(lbl);div.appendChild(aud);wrap.appendChild(div);
  addMeta(wrap,role,id,ts,isPending);$('messages').appendChild(wrap);scrollMsgs();
  if(role==='other'&&id&&ws?.readyState===1)ws.send(JSON.stringify({type:'read',id}));
  return wrap;
}

function addFileMessage(dataUrl,filename,filesize,role,id,ts,isPending){
  const wrap=buildBubble(role,id);
  const div=document.createElement('div');div.className='msg-file';
  const icon=document.createElement('div');icon.className='file-icon';icon.textContent='📄';
  const info=document.createElement('div');info.className='file-info';
  const name=document.createElement('div');name.className='file-name';name.textContent=filename;
  const size=document.createElement('div');size.className='file-size';size.textContent=Math.round(filesize/1024)+' KB';
  info.appendChild(name);info.appendChild(size);
  const dl=document.createElement('a');dl.href=dataUrl;dl.download=filename;dl.className='btn btn-ghost btn-dl';dl.textContent='↓';
  div.appendChild(icon);div.appendChild(info);div.appendChild(dl);wrap.appendChild(div);
  addMeta(wrap,role,id,ts,isPending);$('messages').appendChild(wrap);scrollMsgs();
  if(role==='other'&&id&&ws?.readyState===1)ws.send(JSON.stringify({type:'read',id}));
  return wrap;
}

function addSystem(text){
  const el=document.createElement('div');el.className='msg system';el.textContent='// '+text;
  $('messages').appendChild(el);scrollMsgs();
}

function markDelivered(id){
  const e=myMsgs.get(id);
  if(e&&e.readEl.textContent==='⏳'){e.readEl.textContent='✓';e.readEl.className='read-status';}
}

// ── Selbstlösch ───────────────────────────────────────────────────────────────
function scheduleSelfDestruct(id, seconds) {
  const el = $('messages').querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return;

  // Bereits ein Timer für diese ID? Abbrechen.
  if (sdTimers.has(id)) { clearInterval(sdTimers.get(id)); sdTimers.delete(id); }

  // Sofort löschen wenn seconds=0 (z.B. von self_destruct_ack)
  function destroyMsg() {
    el.classList.add('retracted');
    ['msg-body','msg-img','msg-audio','msg-vid','msg-file'].forEach(cls => el.querySelector('.'+cls)?.remove());
    el.querySelector('.msg-quote')?.remove();
    const ph = document.createElement('div'); ph.className = 'msg-body'; ph.textContent = '[Nachricht gelöscht]';
    const meta = el.querySelector('.msg-meta');
    if (meta) el.insertBefore(ph, meta); else el.appendChild(ph);
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'self_destruct_ack', id }));
  }

  if (seconds <= 0) { destroyMsg(); return; }

  let rem = seconds;
  // Span nur hinzufügen wenn noch nicht vorhanden
  let sdSpan = el.querySelector('.sd-countdown');
  if (!sdSpan) {
    sdSpan = document.createElement('span');
    sdSpan.className = 'sd-countdown';
    el.querySelector('.msg-meta')?.appendChild(sdSpan);
  }
  sdSpan.textContent = `⏱${rem}s`;

  const t = setInterval(() => {
    rem--;
    if (rem <= 0) {
      clearInterval(t);
      sdTimers.delete(id);
      sdSpan.remove();
      destroyMsg();
    } else {
      sdSpan.textContent = `⏱${rem}s`;
    }
  }, 1000);
  sdTimers.set(id, t);
}

// ── Reaktionen ────────────────────────────────────────────────────────────────
function sendReaction(msgId,emoji){if(!ws||ws.readyState!==1)return;ws.send(JSON.stringify({type:'reaction',id:newMsgId(),msgId,emoji}));applyReaction(msgId,emoji,true);}
function applyReaction(msgId,emoji,isMine){
  const c=document.getElementById(`reactions-${msgId}`);if(!c)return;
  let found=null;for(const b of c.querySelectorAll('.reaction-badge'))if(b.dataset.emoji===emoji){found=b;break;}
  if(found){const cnt=parseInt(found.dataset.count||1)+1;found.dataset.count=cnt;found.textContent=emoji+(cnt>1?` ${cnt}`:'');if(isMine)found.classList.add('mine');}
  else{const b=document.createElement('button');b.className='reaction-badge'+(isMine?' mine':'');b.dataset.emoji=emoji;b.dataset.count=1;b.textContent=emoji;c.appendChild(b);}
}

// ── Reply & Edit & Retract ────────────────────────────────────────────────────
function startReply(id,el){replyToId=id;const t=el.querySelector('.msg-text');replyToText=t?t.textContent:'[Medien]';$('reply-preview').style.display='block';$('reply-preview-text').textContent=replyToText.slice(0,80);$('msg-input').focus();}
$('btn-reply-cancel').addEventListener('click',()=>{replyToId=null;replyToText=null;$('reply-preview').style.display='none';});
function startEdit(id,text){editingId=id;$('edit-bar').style.display='block';$('msg-input').value=text;$('msg-input').focus();setTimeout(()=>{if(editingId===id){editingId=null;$('edit-bar').style.display='none';}},EDIT_WINDOW_MS);}
$('btn-edit-cancel').addEventListener('click',()=>{editingId=null;$('edit-bar').style.display='none';$('msg-input').value='';});
function retractMessage(id){if(!ws||ws.readyState!==1)return;ws.send(JSON.stringify({type:'retract',id}));applyRetract(id);}
function applyRetract(id){const own=myMsgs.get(id);if(own){applyRetractEl(own.el);myMsgs.delete(id);return;}const el=$('messages').querySelector(`[data-id="${CSS.escape(id)}"]`);if(el)applyRetractEl(el);}
function applyRetractEl(el){el.classList.add('retracted');['msg-body','msg-img','msg-audio','msg-vid','msg-file','msg-quote'].forEach(cls=>el.querySelector('.'+cls)?.remove());const ph=document.createElement('div');ph.className='msg-body';ph.textContent='[zurückgezogen]';el.insertBefore(ph,el.querySelector('.msg-meta'));el.querySelector('.msg-meta')?.remove();}

// ── Typing ────────────────────────────────────────────────────────────────────
function sendTyping(active){if(!ws||ws.readyState!==1)return;if(active===typingActive)return;typingActive=active;ws.send(JSON.stringify({type:'typing',active}));}
$('msg-input').addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px';sendTyping(true);clearTimeout(typingTimer);typingTimer=setTimeout(()=>sendTyping(false),2000);});

// ── Schriftgröße ──────────────────────────────────────────────────────────────
function applyFontSize(s){fontSize=Math.min(22,Math.max(12,s));$('messages').style.fontSize=fontSize+'px';$('msg-input').style.fontSize=fontSize+'px';$('font-size-label').textContent=fontSize+'px';}
$('font-up').addEventListener('click',()=>applyFontSize(fontSize+1));
$('font-down').addEventListener('click',()=>applyFontSize(fontSize-1));

// ── Action Tray (ausziehbare Icon-Leiste) ─────────────────────────────────────
function initTray() {
  const tray      = $('action-tray');
  const toggleBtn = $('btn-tray-toggle');
  const handle    = $('tray-handle');
  if (!tray || !toggleBtn) return;

  // Auf Desktop (≥600px) immer offen
  const isDesktop = () => window.innerWidth >= 600;

  function openTray() {
    tray.classList.add('expanded');
    toggleBtn.classList.add('open');
  }
  function closeTray() {
    if (isDesktop()) return; // Desktop: nie schließen
    tray.classList.remove('expanded');
    toggleBtn.classList.remove('open');
  }
  function toggleTray() {
    if (isDesktop()) return;
    tray.classList.contains('expanded') ? closeTray() : openTray();
  }

  // Beim Start: Desktop → offen, Mobile → geschlossen
  if (isDesktop()) openTray();

  window.addEventListener('resize', () => {
    if (isDesktop()) openTray();
  });

  toggleBtn.addEventListener('click', toggleTray);
  handle?.addEventListener('click', toggleTray);
  $('msg-input').addEventListener('focus', () => { if (!isDesktop()) closeTray(); });

  // Tray-Buttons mit Aktionen verbinden
  $('btn-call')      ?.addEventListener('click', () => { closeTray(); startCall(false); });
  $('btn-video-call')?.addEventListener('click', () => { closeTray(); startCall(true); });
  $('btn-attach')    ?.addEventListener('click', () => { closeTray(); $('file-input').click(); });
  // Der Knopf traegt bereits weiter unten die vollstaendige Aufnahmeroutine.
  // Vorher stand sie hier ein zweites Mal: beide liefen bei einem Klick an,
  // oeffneten je einen Mikrofonstrom, und nur der zuletzt zugewiesene wurde
  // am Ende geschlossen — das Mikrofon blieb nach dem Senden offen.
  $('btn-mic')       ?.addEventListener('click', () => { closeTray(); });
  $('btn-video-rec') ?.addEventListener('click', () => { closeTray(); });

  $('btn-sd-toggle')?.addEventListener('click', () => {
    sdTextEnabled = !sdTextEnabled;
    $('btn-sd-toggle').classList.toggle('active', sdTextEnabled);
    $('sd-compose-row').style.display = sdTextEnabled ? 'flex' : 'none';
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// WebRTC — Audio & Video Anruf
// ══════════════════════════════════════════════════════════════════════════════
async function getIceServers(){
  if(iceServers) return iceServers;
  try{
    const r = await fetch('/api/turn');
    iceServers = (await r.json()).iceServers;
  }catch{
    iceServers = [
      {urls:'stun:stun.l.google.com:19302'},
      {urls:'stun:stun1.l.google.com:19302'},
    ];
  }
  return iceServers;
}
// ICE-Server sofort vorladen
getIceServers();

let isVideoCall   = false;
let currentFacing = 'user';
let videoMuted    = false;
let audioMuted    = false;

// ── Klingelton ────────────────────────────────────────────────────────────────
// iOS erlaubt AudioContext nur nach User-Geste.
// Wir entsperren den Context beim ersten Button-Klick und spielen dann ab.
let _audioCtxUnlocked = false;
let _ringCtx = null;
let _ringInterval = null;

function unlockAudio(){
  // Beim ersten Tap einen leeren AudioContext erzeugen — entsperrt iOS Audio
  if(_audioCtxUnlocked) return;
  _audioCtxUnlocked = true;
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const buf = ctx.createBuffer(1,1,22050);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start(0);
    ctx.close();
  }catch{}
}
// Audio beim ersten Antippen überall entsperren
document.addEventListener('touchstart', unlockAudio, {once:true, passive:true});
document.addEventListener('click',      unlockAudio, {once:true});

function playRingtone(){
  stopRingtone();
  try{
    _ringCtx = new (window.AudioContext||window.webkitAudioContext)();
    const ring = () => {
      if(!_ringCtx) return;
      [[880,0,0.15],[660,0.18,0.12]].forEach(([freq,delay,dur])=>{
        try{
          const osc  = _ringCtx.createOscillator();
          const gain = _ringCtx.createGain();
          osc.connect(gain); gain.connect(_ringCtx.destination);
          osc.frequency.setValueAtTime(freq, _ringCtx.currentTime + delay);
          gain.gain.setValueAtTime(0.3,   _ringCtx.currentTime + delay);
          gain.gain.exponentialRampToValueAtTime(0.001, _ringCtx.currentTime + delay + dur);
          osc.start(_ringCtx.currentTime + delay);
          osc.stop(_ringCtx.currentTime  + delay + dur);
        }catch{}
      });
    };
    ring();
    _ringInterval = setInterval(ring, 1600);
  }catch(e){ console.warn('[ringtone]', e); }
}

function stopRingtone(){
  clearInterval(_ringInterval); _ringInterval = null;
  try{ _ringCtx?.close(); }catch{}
  _ringCtx = null;
}

// ── Anruf starten ─────────────────────────────────────────────────────────────
async function startCall(withVideo = false){
  if(!partnerConnected){ addSystem('// Partner muss erst online sein.'); return; }
  if(peerConn){ addSystem('// Bereits in einem Anruf.'); return; }

  isVideoCall = withVideo;
  pendingIceCandidates = [];
  window._pendingOffer = null;

  if(withVideo) showVideoCallOverlay('Warte auf Annahme…');
  else showCallBar('Warte auf Annahme…');

  ws.send(JSON.stringify({type:'webrtc_call', withVideo}));
  addSystem(withVideo ? '📹 Videoanruf…' : '📞 Audioanruf…');

  window._callTimeout = setTimeout(()=>{
    if(!peerConn){ cleanupCall(); addSystem('// Nicht angenommen.'); }
  }, 30000);
}

// ── Anrufer: Partner hat angenommen ──────────────────────────────────────────
async function onCallReady(){
  clearTimeout(window._callTimeout);
  try{
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideoCall ? {facingMode: currentFacing, width:{ideal:1280}, height:{ideal:720}} : false
    });
    if(isVideoCall) attachLocalVideo(localStream);

    peerConn = await createPeerConnection();
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));

    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    ws.send(JSON.stringify({type:'webrtc_offer', sdp: peerConn.localDescription}));

    if(isVideoCall) $('video-call-text').textContent = 'Verbinde…';
    else showCallBar('Verbinde…');
  }catch(e){
    addSystem('[Anruf-Fehler: ' + e.message + ']');
    cleanupCall();
  }
}

// ── Empfänger: Anruf annehmen ─────────────────────────────────────────────────
async function answerCall(){
  stopRingtone();
  $('call-incoming').style.display = 'none';
  pendingIceCandidates = [];
  window._pendingOffer = null;

  if(isVideoCall) showVideoCallOverlay('Verbinde…');
  else showCallBar('Verbinde…');
  addSystem(isVideoCall ? '📹 Verbinde…' : '📞 Verbinde…');

  try{
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideoCall ? {facingMode: currentFacing, width:{ideal:1280}, height:{ideal:720}} : false
    });
    if(isVideoCall) attachLocalVideo(localStream);

    peerConn = await createPeerConnection();
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));

    // Bereit-Signal NACH PeerConnection-Setup senden
    ws.send(JSON.stringify({type:'webrtc_ready'}));

  }catch(e){
    addSystem('[Annehmen-Fehler: ' + e.message + ']');
    ws.send(JSON.stringify({type:'webrtc_hangup'}));
    cleanupCall();
  }
}

// ── handleOffer ───────────────────────────────────────────────────────────────
async function handleOffer(sdp){
  if(!peerConn) return;
  await peerConn.setRemoteDescription(new RTCSessionDescription(sdp));
  // Gepufferte ICE-Kandidaten jetzt anwenden
  const queued = [...pendingIceCandidates]; pendingIceCandidates = [];
  for(const c of queued){
    try{ await peerConn.addIceCandidate(new RTCIceCandidate(c)); }catch{}
  }
  const answer = await peerConn.createAnswer();
  await peerConn.setLocalDescription(answer);
  ws.send(JSON.stringify({type:'webrtc_answer', sdp: peerConn.localDescription}));
}

// ── PeerConnection ────────────────────────────────────────────────────────────
async function createPeerConnection(){
  const servers = await getIceServers();
  const pc = new RTCPeerConnection({iceServers: servers, iceCandidatePoolSize: 10});

  pc.onicecandidate = e => {
    if(e.candidate && ws?.readyState === 1)
      ws.send(JSON.stringify({type:'webrtc_ice', candidate: e.candidate}));
  };

  pc.ontrack = e => {
    const stream = e.streams?.[0];
    if(!stream) return;

    if(e.track.kind === 'video'){
      isVideoCall = true;
      // Video-Overlay beim Empfänger öffnen falls noch nicht offen
      if($('video-call-overlay').style.display !== 'block')
        showVideoCallOverlay('Verbunden');

      const rv = $('remote-video');
      if(rv){
        rv.srcObject = stream;
        rv.play().catch(()=> setTimeout(()=> rv.play().catch(()=>{}), 500));
      }
      $('video-waiting')?.remove();
    }

    if(e.track.kind === 'audio'){
      const ra = $('remote-audio');
      if(ra){
        ra.srcObject = stream;
        ra.play().catch(()=> setTimeout(()=> ra.play().catch(()=>{}), 500));
      }
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[WebRTC]', pc.connectionState);
    if(pc.connectionState === 'connected'){
      if(isVideoCall){
        $('video-call-text').textContent = 'Verbunden';
        $('video-call-dot').classList.add('active');
        startVideoCallTimer();
      }else{
        showCallBar('Verbunden');
        $('call-status-dot').classList.add('active');
        startCallTimer();
      }
      addSystem(isVideoCall ? '📹 Videoanruf verbunden.' : '📞 Anruf verbunden.');
    }else if(pc.connectionState === 'disconnected'){
      setTimeout(()=>{
        if(peerConn?.connectionState === 'disconnected' && !intentionalClose)
          scheduleCallReconnect();
      }, 2000);
    }else if(pc.connectionState === 'failed'){
      if(!intentionalClose) scheduleCallReconnect();
    }else if(pc.connectionState === 'closed'){
      if(!intentionalClose) cleanupCall();
    }
  };

  return pc;
}

// ── Video-Overlay ─────────────────────────────────────────────────────────────
function showVideoCallOverlay(text){
  $('video-call-overlay').style.display = 'block';
  $('video-call-text').textContent = text;
  $('call-bar').style.display = 'none';
  $('call-incoming').style.display = 'none';
  let w = $('video-waiting');
  if(!w){
    w = document.createElement('div'); w.className='video-waiting'; w.id='video-waiting';
    w.textContent = '> Warte auf Partner-Video…';
    $('video-call-overlay').appendChild(w);
  }
}

function attachLocalVideo(stream){
  const lv = $('local-video');
  if(!lv) return;
  lv.srcObject = stream; lv.muted = true;
  lv.play().catch(()=> setTimeout(()=> lv.play().catch(()=>{}), 300));
}

// ── Kamera wechseln ───────────────────────────────────────────────────────────
async function flipCamera(){
  if(!localStream || !isVideoCall || !peerConn) return;
  currentFacing = currentFacing === 'user' ? 'environment' : 'user';
  try{
    localStream.getVideoTracks().forEach(t => t.stop());
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {facingMode: currentFacing}
    });
    const newTrack = newStream.getVideoTracks()[0];
    const sender = peerConn.getSenders().find(s => s.track?.kind === 'video');
    if(sender) await sender.replaceTrack(newTrack);
    localStream.removeTrack(localStream.getVideoTracks()[0]);
    localStream.addTrack(newTrack);
    attachLocalVideo(localStream);
    addSystem('// Kamera: ' + (currentFacing==='user' ? 'Vorne' : 'Hinten'));
  }catch(e){ addSystem('[Kamera-Wechsel: ' + e.message + ']'); }
}

// ── Qualität & Reconnect ──────────────────────────────────────────────────────
let qualityInterval = null;
let lastBytesReceived = 0;
const MAX_CALL_RECONNECTS = 3;
let callReconnectTimer = null;

function startQualityMonitor(){
  stopQualityMonitor(); lastBytesReceived = 0;
  qualityInterval = setInterval(async()=>{
    if(!peerConn) return;
    try{
      const stats = await peerConn.getStats();
      let rtt=null, pLost=0, pRec=0, bRec=0;
      stats.forEach(r=>{
        if(r.type==='inbound-rtp'){ pLost+=r.packetsLost||0; pRec+=r.packetsReceived||0; bRec+=r.bytesReceived||0; }
        if(r.type==='candidate-pair'&&r.state==='succeeded'&&r.currentRoundTripTime)
          rtt = Math.round(r.currentRoundTripTime*1000);
      });
      const loss = (pLost+pRec)>0 ? pLost/(pLost+pRec) : 0;
      const hasData = bRec > lastBytesReceived; lastBytesReceived = bRec;
      let q = 'good';
      if(!hasData && callSeconds>5) q='poor';
      else if(loss>0.1||rtt>300) q='poor';
      else if(loss>0.03||rtt>150) q='medium';
      const aq=$('call-quality');     if(aq){ aq.className=`quality-indicator ${q}`; if(rtt) aq.title=rtt+'ms'; }
      const vq=$('video-call-quality');if(vq){ vq.className=`quality-indicator ${q}`; if(rtt) vq.title=rtt+'ms'; }
    }catch{}
  }, 2000);
}
function stopQualityMonitor(){ clearInterval(qualityInterval); qualityInterval=null; }

function scheduleCallReconnect(){
  if(intentionalClose||!roomId||callReconnectAttempts>=MAX_CALL_RECONNECTS){
    if(callReconnectAttempts>=MAX_CALL_RECONNECTS){ addSystem('// Anruf konnte nicht wiederhergestellt werden.'); cleanupCall(); }
    return;
  }
  callReconnectAttempts++;
  const delay = callReconnectAttempts * 2000;
  const b=$('call-reconnect-banner'); if(b) b.classList.add('visible');
  addSystem(`// Anruf unterbrochen — Versuch ${callReconnectAttempts}/${MAX_CALL_RECONNECTS}…`);
  callReconnectTimer = setTimeout(async()=>{
    if(!peerConn||!partnerConnected){ cleanupCall(); return; }
    try{
      const offer = await peerConn.createOffer({iceRestart:true});
      await peerConn.setLocalDescription(offer);
      ws.send(JSON.stringify({type:'webrtc_offer', sdp:peerConn.localDescription}));
      const b=$('call-reconnect-banner'); if(b) b.classList.remove('visible');
    }catch(e){ addSystem('[Reconnect: '+e.message+']'); cleanupCall(); }
  }, delay);
}
function cancelCallReconnect(){
  clearTimeout(callReconnectTimer); callReconnectTimer=null;
  const b=$('call-reconnect-banner'); if(b) b.classList.remove('visible');
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startCallTimer(){
  callSeconds=0; callReconnectAttempts=0;
  $('call-timer').style.display='inline';
  callTimer=setInterval(()=>{
    callSeconds++;
    const m=Math.floor(callSeconds/60),s=callSeconds%60;
    $('call-timer').textContent=`${m}:${String(s).padStart(2,'0')}`;
  },1000);
  startQualityMonitor();
}
function startVideoCallTimer(){
  callSeconds=0; callReconnectAttempts=0;
  $('video-call-timer').style.display='inline';
  callTimer=setInterval(()=>{
    callSeconds++;
    const m=Math.floor(callSeconds/60),s=callSeconds%60;
    $('video-call-timer').textContent=`${m}:${String(s).padStart(2,'0')}`;
  },1000);
  startQualityMonitor();
}

function hangup(){
  ws?.readyState===1 && ws.send(JSON.stringify({type:'webrtc_hangup'}));
  cleanupCall(); addSystem('📵 Anruf beendet.');
}

function cleanupCall(){
  clearInterval(callTimer); callSeconds=0;
  clearTimeout(window._callTimeout);
  cancelCallReconnect();
  stopQualityMonitor();
  window._pendingOffer=null;
  pendingIceCandidates=[];
  callReconnectAttempts=0;
  isVideoCall=false; currentFacing='user'; videoMuted=false; audioMuted=false;
  stopRingtone();

  // Video/Audio Elemente zuerst loslassen
  const rv=$('remote-video'); if(rv){ rv.pause(); rv.srcObject=null; try{rv.load();}catch{} }
  const lv=$('local-video');  if(lv){ lv.pause(); lv.srcObject=null; try{lv.load();}catch{} }
  const ra=$('remote-audio'); if(ra){ ra.pause(); ra.srcObject=null; }

  // Tracks stoppen
  if(localStream){ localStream.getTracks().forEach(t=>{ try{t.stop();}catch{} }); localStream=null; }

  // PeerConnection schließen
  if(peerConn){ try{peerConn.close();}catch{} peerConn=null; }

  // UI
  $('call-bar').style.display='none';
  $('call-incoming').style.display='none';
  $('video-call-overlay').style.display='none';
  $('call-timer').style.display='none';
  $('video-call-timer').style.display='none';
  $('call-status-dot').classList.remove('active');
  $('video-call-dot').classList.remove('active');
  const bm=$('btn-mute'); if(bm){bm.textContent='🎤';bm.classList.remove('muted');}
  const vm=$('btn-vid-mute'); if(vm){vm.textContent='🎤';vm.classList.remove('muted');}
  const vc=$('btn-vid-cam'); if(vc){vc.textContent='📷';vc.classList.remove('muted');}
  document.querySelector('.video-shield')?.remove();
}

// ── Call Buttons ──────────────────────────────────────────────────────────────
$('btn-call')      ?.addEventListener('click', ()=>startCall(false));
$('btn-video-call')?.addEventListener('click', ()=>startCall(true));
$('btn-hangup')    ?.addEventListener('click', hangup);
$('btn-vid-hangup')?.addEventListener('click', hangup);
$('btn-accept')    ?.addEventListener('click', answerCall);
$('btn-reject')    ?.addEventListener('click', ()=>{
  $('call-incoming').style.display='none'; stopRingtone();
  ws?.readyState===1&&ws.send(JSON.stringify({type:'webrtc_hangup'}));
  addSystem('Anruf abgelehnt.');
});

// Stummschalten Audio
$('btn-mute')?.addEventListener('click',()=>{
  if(!localStream)return;
  audioMuted=!audioMuted;localStream.getAudioTracks().forEach(t=>t.enabled=!audioMuted);
  $('btn-mute').textContent=audioMuted?'🔇':'🎤';$('btn-mute').classList.toggle('muted',audioMuted);
});
$('btn-vid-mute')?.addEventListener('click',()=>{
  if(!localStream)return;
  audioMuted=!audioMuted;localStream.getAudioTracks().forEach(t=>t.enabled=!audioMuted);
  $('btn-vid-mute').textContent=audioMuted?'🔇':'🎤';$('btn-vid-mute').classList.toggle('muted',audioMuted);
});

// Kamera an/aus
$('btn-vid-cam')?.addEventListener('click',()=>{
  if(!localStream)return;
  videoMuted=!videoMuted;localStream.getVideoTracks().forEach(t=>t.enabled=!videoMuted);
  $('btn-vid-cam').textContent=videoMuted?'🚫':'📷';
  $('btn-vid-cam').classList.toggle('muted',videoMuted);
});

// Kamera wechseln (vorne ↔ hinten)
$('btn-vid-flip')?.addEventListener('click', flipCamera);

// Lautsprecher
$('btn-speaker')?.addEventListener('click',()=>{
  const ra=$('remote-audio');if(!ra)return;ra.muted=!ra.muted;
  $('btn-speaker').textContent=ra.muted?'🔈':'🔊';
});

// Lokales Video antippen → Position wechseln (PiP)
$('local-video')?.addEventListener('click',()=>{
  $('local-video').classList.toggle('pip-topleft');
});

function showCallBar(statusText){
  $('call-bar').style.display='flex';
  $('call-status-text').textContent=statusText;
  $('call-incoming').style.display='none';
}

// startCallTimer, hangup, cleanupCall sind weiter oben definiert


// ══════════════════════════════════════════════════════════════════════════════
// MEDIEN SENDEN
// ══════════════════════════════════════════════════════════════════════════════
async function handleFileOrImage(file){
  if(!file||!ws||ws.readyState!==1){addSystem('[Nicht verbunden — bitte warten]');return;}
  const isImage=file.type.startsWith('image/'),isVideo=file.type.startsWith('video/');
  if(isImage){
    addSystem('Bild wird verarbeitet …');
    try{
      const{dataUrl,mime,size}=await compressImage(file);
      if(size>MAX_IMG_BYTES){addSystem(`[Bild zu groß nach Komprimierung: ${Math.round(size/1024)}KB — bitte kleineres Bild wählen]`);return;}
      addSystem(`Bild bereit (${Math.round(size/1024)} KB) — wird gesendet…`);
      pendingMediaData=dataUrl;pendingMediaMime=mime;pendingMediaType='image';
      $('img-preview').src=dataUrl;$('img-preview').style.display='block';
      $('vid-preview').style.display='none';$('media-preview-overlay').style.display='flex';
    }catch(e){addSystem('[Bild konnte nicht verarbeitet werden: '+e.message+']');}
  }else if(isVideo){
    if(file.size>MAX_FILE_BYTES*5){addSystem('[Video zu groß — max. 40MB]');return;}
    addSystem('Video wird geladen…');
    const reader=new FileReader();
    reader.onload=e=>{
      pendingMediaData=e.target.result;pendingMediaMime=file.type;pendingMediaType='video';
      $('vid-preview').src=e.target.result;$('vid-preview').style.display='block';
      $('img-preview').style.display='none';$('media-preview-overlay').style.display='flex';
    };
    reader.onerror=()=>addSystem('[Video konnte nicht geladen werden]');
    reader.readAsDataURL(file);
  }else{
    if(file.size>MAX_FILE_BYTES){addSystem(`[Datei zu groß — max. ${MAX_FILE_BYTES/1024/1024}MB]`);return;}
    addSystem(`Datei "${file.name}" wird gesendet…`);
    const reader=new FileReader();
    reader.onload=async e=>{
      const id=newMsgId();
      try{const payload=await encrypt(e.target.result);ws.send(JSON.stringify({type:'file',id,payload,filename:file.name,filesize:file.size}));addFileMessage(e.target.result,file.name,file.size,'self',id,Date.now(),!partnerConnected);addSystem(`✓ "${file.name}" gesendet.`);}
      catch(err){addSystem('[Datei konnte nicht gesendet werden: '+err.message+']');}
    };
    reader.onerror=()=>addSystem('[Datei konnte nicht gelesen werden]');
    reader.readAsDataURL(file);
  }
}

// btn-attach handled in initTray
$('file-input').addEventListener('change',async e=>{for(const f of e.target.files)await handleFileOrImage(f);e.target.value='';});
$('btn-media-cancel').addEventListener('click',()=>{$('media-preview-overlay').style.display='none';pendingMediaData=null;});
$('btn-media-send').addEventListener('click',async()=>{
  if(!pendingMediaData||ws?.readyState!==1){addSystem('[Nicht verbunden]');return;}
  $('media-preview-overlay').style.display='none';
  addSystem('Wird gesendet…');
  const id=newMsgId(),sdSeconds=$('sd-check').checked?parseInt($('sd-timer').value):null;
  try{
    const payload=await encrypt(pendingMediaData);
    if(pendingMediaType==='image'){
      ws.send(JSON.stringify({type:'image',id,payload,mime:pendingMediaMime,sdSeconds}));
      addImageMessage(pendingMediaData,'self',id,Date.now(),!partnerConnected);
      if(sdSeconds)scheduleSelfDestruct(id,sdSeconds);
    }else{
      ws.send(JSON.stringify({type:'video',id,payload,sdSeconds}));
      addVideoMessage(pendingMediaData,'self',id,Date.now(),!partnerConnected);
      if(sdSeconds)scheduleSelfDestruct(id,sdSeconds);
    }
    addSystem('✓ Gesendet.');
  }catch(err){addSystem('[Senden fehlgeschlagen: '+err.message+' — bitte nochmal versuchen]');}
  pendingMediaData=null;pendingMediaMime=null;pendingMediaType=null;
});

// ── Video aufnehmen ───────────────────────────────────────────────────────────
$('btn-video-rec') && $('btn-video-rec').addEventListener('click',async()=>{
  if(videoRecorder?.state==='recording')return;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    $('video-preview-live').srcObject=stream;videoChunks=[];videoRecSeconds=0;
    const mime=getSupportedVideoMime();
    videoRecorder=new MediaRecorder(stream,mime?{mimeType:mime}:{});
    videoRecorder.ondataavailable=e=>{if(e.data.size>0)videoChunks.push(e.data);};
    videoRecorder.onstop=()=>{
      clearInterval(videoRecInterval);stream.getTracks().forEach(t=>t.stop());
      $('video-rec-bar').classList.remove('active');$('video-preview-live').srcObject=null;
      if(!videoChunks.length)return;
      const blob=new Blob(videoChunks,{type:mime||'video/webm'});
      const reader=new FileReader();
      reader.onload=e=>{pendingMediaData=e.target.result;pendingMediaMime=mime||'video/webm';pendingMediaType='video';$('vid-preview').src=e.target.result;$('vid-preview').style.display='block';$('img-preview').style.display='none';$('media-preview-overlay').style.display='flex';};
      reader.readAsDataURL(blob);
    };
    videoRecorder.start();$('video-rec-bar').classList.add('active');$('video-rec-time').textContent='0:00';
    videoRecInterval=setInterval(()=>{videoRecSeconds++;const m=Math.floor(videoRecSeconds/60),s=videoRecSeconds%60;$('video-rec-time').textContent=`${m}:${String(s).padStart(2,'0')}`;if(videoRecSeconds>=VIDEO_MAX_SEC)stopVideoRec();},1000);
  }catch{addSystem('[Kein Kamerazugriff]');}
});
function stopVideoRec(){if(videoRecorder?.state==='recording')videoRecorder.stop();}
$('btn-video-cancel')?.addEventListener('click',()=>{videoChunks=[];if(videoRecorder?.state==='recording'){videoRecorder.onstop=()=>{clearInterval(videoRecInterval);$('video-rec-bar').classList.remove('active');$('video-preview-live').srcObject=null;};videoRecorder.stop();}});
$('btn-video-send')?.addEventListener('click',stopVideoRec);

// ── Audio aufnehmen ───────────────────────────────────────────────────────────
let analyser=null,waveAnim=null;
function drawWaveform(){
  if(!analyser)return;const canvas=$('waveform'),ctx=canvas.getContext('2d');const buf=new Uint8Array(analyser.frequencyBinCount);
  const draw=()=>{waveAnim=requestAnimationFrame(draw);analyser.getByteTimeDomainData(buf);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#00ff41';ctx.lineWidth=1.5;ctx.beginPath();const sw=canvas.width/buf.length;buf.forEach((v,i)=>{const x=i*sw,y=(v/128)*canvas.height/2;i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});ctx.stroke();};draw();
}
$('btn-mic').addEventListener('click',async()=>{
  if(mediaRecorder?.state==='recording')return;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    const src=audioCtx.createMediaStreamSource(stream);
    analyser=audioCtx.createAnalyser();analyser.fftSize=256;src.connect(analyser);
    audioChunks=[];recSeconds=0;
    const mime=getSupportedAudioMime(); // iOS Fix
    try{mediaRecorder=new MediaRecorder(stream,mime?{mimeType:mime}:{});}
    catch{mediaRecorder=new MediaRecorder(stream);} // Fallback ohne mimeType
    mediaRecorder.ondataavailable=e=>{if(e.data.size>0)audioChunks.push(e.data);};
    mediaRecorder.onstop=async()=>{
      cancelAnimationFrame(waveAnim);clearInterval(recInterval);
      stream.getTracks().forEach(t=>t.stop());audioCtx.close();
      $('recording-bar').classList.remove('active');
      if(!audioChunks.length){addSystem('[Keine Audiodaten aufgenommen]');return;}
      const actualMime=mediaRecorder.mimeType||mime||'audio/webm';
      const blob=new Blob(audioChunks,{type:actualMime});
      addSystem(`Sprachnachricht (${Math.round(blob.size/1024)}KB) wird gesendet…`);
      const r=new FileReader();
      r.onload=async e=>{
        const id=newMsgId();
        try{const payload=await encrypt(e.target.result);ws.send(JSON.stringify({type:'audio',id,payload}));addAudioMessage(e.target.result,'self',id,Date.now(),!partnerConnected);addSystem('✓ Sprachnachricht gesendet.');}
        catch(err){addSystem('[Sprachnachricht konnte nicht gesendet werden: '+err.message+']');}
      };
      r.onerror=()=>addSystem('[Audiodatei konnte nicht gelesen werden]');
      r.readAsDataURL(blob);
    };
    mediaRecorder.start(100); // timeslice für stabilere Chunks auf iOS
    $('recording-bar').classList.add('active');$('rec-time').textContent='0:00';
    recInterval=setInterval(()=>{recSeconds++;const m=Math.floor(recSeconds/60),s=recSeconds%60;$('rec-time').textContent=`${m}:${String(s).padStart(2,'0')}`;if(recSeconds>=120)stopRec();},1000);
    drawWaveform();
  }catch(e){addSystem('[Kein Mikrofonzugriff: '+e.message+']');}
});
function stopRec(){if(mediaRecorder?.state==='recording')mediaRecorder.stop();}
$('btn-rec-cancel').addEventListener('click',()=>{audioChunks=[];if(mediaRecorder?.state==='recording'){mediaRecorder.onstop=()=>{cancelAnimationFrame(waveAnim);clearInterval(recInterval);$('recording-bar').classList.remove('active');};mediaRecorder.stop();}});
$('btn-rec-send').addEventListener('click',stopRec);

// ── Text senden ───────────────────────────────────────────────────────────────
async function sendMessage(){
  const input=$('msg-input'),text=input.value.trim();
  if(!text||!ws||ws.readyState!==1)return;
  if(editingId){
    const id=editingId;editingId=null;$('edit-bar').style.display='none';input.value='';input.style.height='';
    try{const payload=await encrypt(text);ws.send(JSON.stringify({type:'edit',id,payload}));const el=$('messages').querySelector(`[data-id="${CSS.escape(id)}"]`);if(el){const t=el.querySelector('.msg-text');if(t)t.textContent=text;let ed=el.querySelector('.edited-label');if(!ed){ed=document.createElement('span');ed.className='edited-label';ed.textContent='(bearbeitet)';el.querySelector('.msg-meta')?.prepend(ed);}}}
    catch{addSystem('[Bearbeitung fehlgeschlagen]');}return;
  }
  if(text.length>MAX_TEXT_LEN){addSystem(`[Max. ${MAX_TEXT_LEN} Zeichen]`);return;}
  input.value='';input.style.height='';sendTyping(false);
  const id=newMsgId(),sdSeconds=sdTextEnabled?parseInt($('sd-text-timer').value):null;
  const qId=replyToId,qText=replyToText;replyToId=null;replyToText=null;$('reply-preview').style.display='none';
  try{
    const payload=await encrypt(text);
    ws.send(JSON.stringify({type:'reply',id,payload,quoteId:qId,quoteText:qText?.slice(0,120),sdSeconds}));
    addTextMessage(text,'self',id,Date.now(),!partnerConnected,qId,qText);
    if(sdSeconds)scheduleSelfDestruct(id,sdSeconds);
  }catch{addSystem('[Verschlüsselung fehlgeschlagen]');}
}
$('btn-send').addEventListener('click',sendMessage);
$('msg-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});

// ── Einladungs-Text ───────────────────────────────────────────────────────────
function buildInviteText(link,senderName){
  const name=(senderName||'').trim();
  const shortLink=link.replace(/^https?:\/\//,'').split('#')[0];
  const greeting=name?`${name} lädt dich zu einem privaten Chat ein.`:'Du wurdest zu einem privaten Chat eingeladen.';
  return{message:`🔒 ${greeting}\n\nSicher · Ende-zu-Ende-verschlüsselt · Kein Login nötig\n\n${link}`,shortLink,greeting};
}

function populateShareScreen(link,senderName){
  const{message,shortLink,greeting}=buildInviteText(link,senderName);
  const sl=$('invite-sender-line');if(sl)sl.textContent=greeting;
  const tp=$('invite-text-preview');if(tp)tp.textContent='Sicher · Ende-zu-Ende-verschlüsselt · Kein Login nötig';
  const ls=$('invite-link-short');if(ls)ls.textContent=shortLink;
  return message;
}

// ── Raum erstellen ────────────────────────────────────────────────────────────
$('btn-create').addEventListener('click',async()=>{
  $('btn-create').disabled=true;$('btn-create').textContent='Verschlüssele …';
  try{
    const{key,b64url}=await generateKey();cryptoKey=key;window.secShowKey&&secShowKey(b64url);
    const pwPlain=$('pw-input').value,senderName=($('sender-name')?.value||'').trim();
    const pwHash=pwPlain?await hashPassword(pwPlain):null;
    const res=await fetch('/api/room',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pwHash})});
    if(!res.ok)throw new Error();
    const data=await res.json();roomId=data.roomId;
    const link=`${location.origin}/r/${roomId}#${b64url}`;
    pendingRoomLink=link;
    const inviteMsg=populateShareScreen(link,senderName);
    try{await navigator.clipboard.writeText(inviteMsg);$('copy-notice-big').textContent='✓ EINLADUNG KOPIERT — In WhatsApp einfügen!';}
    catch{$('copy-notice-big').textContent='Auf EINLADUNG KOPIEREN tippen';}
    pendingPwHash=null;showScreen('share');startCountdown(Date.now());
  }catch{
    $('btn-create').disabled=false;$('btn-create').textContent='Sicheren Chat erstellen';
    alert('Raum konnte nicht erstellt werden.');
  }
});

if($('btn-copy-big')){
  $('btn-copy-big').addEventListener('click',async()=>{
    if(!pendingRoomLink)return;
    const senderName=($('sender-name')?.value||'').trim();
    const{message}=buildInviteText(pendingRoomLink,senderName);
    try{await navigator.clipboard.writeText(message);$('btn-copy-big').textContent='✓ KOPIERT!';$('copy-notice-big').textContent='✓ EINLADUNG KOPIERT — In WhatsApp einfügen!';setTimeout(()=>$('btn-copy-big').textContent='📋 EINLADUNG KOPIEREN',2500);}
    catch{if($('invite-link-short')){const r=document.createRange();r.selectNode($('invite-link-short'));getSelection().removeAllRanges();getSelection().addRange(r);}}
  });
}
if($('btn-share-qr')){$('btn-share-qr').addEventListener('click',()=>{if(pendingRoomLink)showQR(pendingRoomLink);});}
if($('btn-open-chat')){
  $('btn-open-chat').addEventListener('click',()=>{
    // Diskreter Link-Button im Header setzen
    const linkBtn=$('btn-copy-link');
    if(linkBtn){
      linkBtn.style.display='flex';
      linkBtn.onclick=async()=>{
        if(!pendingRoomLink)return;
        try{await navigator.clipboard.writeText(pendingRoomLink);linkBtn.textContent='✓';setTimeout(()=>linkBtn.textContent='🔗',2000);}
        catch{showQR(pendingRoomLink);}
      };
    }
    showScreen('chat');openWebSocket();
  });
}

// ── PW Join ───────────────────────────────────────────────────────────────────
$('btn-pw-join').addEventListener('click',joinWithPassword);
$('pw-join').addEventListener('keydown',e=>{if(e.key==='Enter')joinWithPassword();});
async function joinWithPassword(){
  const pw=$('pw-join').value;if(!pw){$('pw-error').style.display='block';return;}
  pendingPwHash=await hashPassword(pw);$('pw-error').style.display='none';
  showScreen('chat');openWebSocket();
  try{const r=await fetch(`/api/room/${roomId}`);if(r.ok){const d=await r.json();startCountdown(d.createdAt);}}catch{}
}

// ── Fragment Init ─────────────────────────────────────────────────────────────
async function initFromFragment(){
  const match=location.pathname.match(/^\/r\/([a-f0-9]{32})$/);if(!match)return false;
  const frag=location.hash.slice(1);if(!frag){showClosed('Ungültiger Link.');return true;}
  roomId=match[1];
  try{cryptoKey=await importKey(frag);}catch{showClosed('Schlüssel ungültig.');return true;}
  history.replaceState(null,'',location.pathname);
  try{
    const res=await fetch(`/api/room/${roomId}`);
    if(!res.ok){showClosed('Raum existiert nicht oder wurde gelöscht.');return true;}
    const data=await res.json();
    if(data.hasPassword){showScreen('pw');return true;}
    showScreen('chat');openWebSocket();startCountdown(data.createdAt);
  }catch{showScreen('chat');openWebSocket();}
  return true;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function openWebSocket(){
  if(ws){try{ws.close();}catch{}ws=null;}stopKeepalive();
  const token = getSessionToken();
  ws=new WebSocket(`${WS_PROTO}//${location.host}/ws/${roomId}?token=${encodeURIComponent(token)}`);

  ws.addEventListener('open',()=>{
    reconnectAttempts=0;cancelReconnect();
    setStatus('waiting','WARTE AUF PARTNER …');
    enableInput(true);startKeepalive();
    if(pendingPwHash)ws.send(JSON.stringify({type:'auth',pwHash:pendingPwHash}));
    if($('messages').children.length===0)
      addSystem('Verbunden. Du kannst bereits schreiben — Nachrichten werden zugestellt wenn der andere beitritt.');
    else addSystem('✓ Verbindung wiederhergestellt.');
  });

  ws.addEventListener('message',async evt=>{
    let msg;try{msg=JSON.parse(evt.data);}catch{return;}
    switch(msg.type){
      case 'pong':break;
      case 'auth_ok':addSystem('Passwort korrekt ✓');break;
      case 'auth_fail':intentionalClose=true;showClosed('Falsches Passwort.');break;
      case 'room_sealed':$('sealed-banner').classList.add('visible');break;

      case 'participant_count':{
        const was=partnerConnected;partnerConnected=msg.count>=2;
        if(partnerConnected&&!was){
          setStatus('connected','VERBUNDEN · E2E-VERSCHLÜSSELT');
          setPartnerBanner('online');addSystem('Partner ist online.');
          for(const[id] of myMsgs)markDelivered(id);hasShownNewMsgDivider=false;
        }else if(!partnerConnected&&was){
          setStatus('waiting','PARTNER OFFLINE');setPartnerBanner('offline');
          addSystem('Partner hat die Verbindung getrennt. Raum läuft weiter.');
          hasShownNewMsgDivider=false;
          // Anruf beenden wenn Partner weg
          if(peerConn)cleanupCall();
        }else if(!partnerConnected)setStatus('waiting','WARTE AUF PARTNER …');
        break;
      }

      case 'chat':case 'reply':{
        if(!partnerConnected)insertNewMsgDivider();
        try{const plain=await decrypt(msg.payload);addTextMessage(plain,'other',msg.id,msg.ts,false,msg.quoteId,msg.quoteText);if(msg.pending)addSystem('Gesendet bevor du beigetreten bist.');if(msg.sdSeconds)scheduleSelfDestruct(msg.id,msg.sdSeconds);playPing();vibrate();bumpUnread();}
        catch{addSystem('[Entschlüsselung fehlgeschlagen]');}
        $('typing-indicator').style.display='none';break;
      }
      case 'image':{try{const p=await decrypt(msg.payload);addImageMessage(p,'other',msg.id,msg.ts,false);if(msg.sdSeconds)scheduleSelfDestruct(msg.id,msg.sdSeconds);playPing();vibrate();bumpUnread();}catch{addSystem('[Bild nicht entschlüsselbar]');}break;}
      case 'video':{try{const p=await decrypt(msg.payload);addVideoMessage(p,'other',msg.id,msg.ts,false);if(msg.sdSeconds)scheduleSelfDestruct(msg.id,msg.sdSeconds);playPing();vibrate();bumpUnread();}catch{addSystem('[Video nicht entschlüsselbar]');}break;}
      case 'audio':{try{const p=await decrypt(msg.payload);addAudioMessage(p,'other',msg.id,msg.ts,false);playPing();vibrate();bumpUnread();}catch{addSystem('[Audio nicht entschlüsselbar]');}break;}
      case 'file':{try{const p=await decrypt(msg.payload);addFileMessage(p,msg.filename,msg.filesize,'other',msg.id,msg.ts,false);playPing();vibrate();bumpUnread();}catch{addSystem('[Datei nicht entschlüsselbar]');}break;}
      case 'reaction':applyReaction(msg.msgId,msg.emoji,false);break;
      case 'buffered':break;

      case 'read':{
        const e=myMsgs.get(msg.id);
        if(e){e.readEl.textContent='✓✓';e.readEl.className='read-status read-check';
          const tl=document.createElement('span');tl.className='read-time';tl.textContent=` ${msg.readAt}`;e.readEl.after(tl);}break;
      }
      case 'typing':$('typing-indicator').style.display=msg.active?'flex':'none';break;
      case 'retract':applyRetract(msg.id);break;
      case 'self_destruct_ack':scheduleSelfDestruct(msg.id,0);break;

      case 'edit':{
        try{const plain=await decrypt(msg.payload);const el=$('messages').querySelector(`[data-id="${CSS.escape(msg.id)}"]`);if(el){const t=el.querySelector('.msg-text');if(t)t.textContent=plain;let ed=el.querySelector('.edited-label');if(!ed){ed=document.createElement('span');ed.className='edited-label';ed.textContent='(bearbeitet)';el.querySelector('.msg-meta')?.prepend(ed);}}}catch{}break;
      }
      case 'extended':roomExpiry=msg.newExpiry;addSystem(`Raum verlängert. Noch ${msg.extensionsLeft}× möglich.`);break;

      // ── WebRTC Signaling ──────────────────────────────────────────────────
      case 'webrtc_call':
        isVideoCall = !!msg.withVideo;
        $('call-incoming').style.display='block';
        $('incoming-type-text').textContent = isVideoCall ? '📹 Eingehender Videoanruf…' : '📞 Eingehender Anruf…';
        playRingtone();vibrate([200,100,200,100,200]);
        addSystem(isVideoCall?'📹 Eingehender Videoanruf — Annehmen oder Ablehnen':'📞 Eingehender Anruf — Annehmen oder Ablehnen');
        break;

      case 'webrtc_ready':
        // Partner hat angenommen — jetzt können wir den Offer senden
        clearTimeout(window._callTimeout);
        await onCallReady();
        break;

      case 'webrtc_offer':
        // Da answerCall() Ressourcen VOR 'webrtc_ready' vorbereitet,
        // ist peerConn hier praktisch immer schon bereit.
        if(peerConn){
          await handleOffer(msg.sdp);
        }else{
          // Fallback: Offer kam überraschend früh an → puffern
          window._pendingOffer=msg.sdp;
        }
        break;

      case 'webrtc_answer':
        if(peerConn && peerConn.signalingState==='have-local-offer'){
          try{
            await peerConn.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            await flushPendingIce(); // Gepufferte Kandidaten jetzt verarbeiten
          }catch(e){addSystem('[Anruf-Fehler: '+e.message+']');}
        }break;

      case 'webrtc_ice':
        if(msg.candidate){
          if(peerConn && peerConn.remoteDescription){
            // Sofort verarbeiten — remoteDescription ist gesetzt
            try{ await peerConn.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
            catch(e){ console.warn('[ICE]',e.message); }
          }else{
            // PeerConnection noch nicht bereit ODER remoteDescription fehlt noch
            // → puffern statt verwerfen
            pendingIceCandidates.push(msg.candidate);
          }
        }break;

      case 'webrtc_hangup':
        cleanupCall();addSystem('📵 Gesprächspartner hat aufgelegt.');break;

      case 'room_closed':intentionalClose=true;showClosed(closedReason(msg.reason));break;
      case 'error':
        if(msg.code==='not_authenticated'){intentionalClose=true;showClosed('Authentifizierung fehlgeschlagen.');}
        else if(msg.code==='max_extensions')addSystem('[Max. 3 Verlängerungen erreicht]');
        else addSystem(`[Fehler: ${msg.code}]`);break;
    }
  });

  ws.addEventListener('close',evt=>{
    stopKeepalive();
    if(screens.closed.classList.contains('active')||intentionalClose)return;
    if(evt.code===4001){showClosed('Raum existiert nicht oder ist abgelaufen.');return;}
    if(evt.code===4002){showClosed('Raum ist voll.');return;}
    if(evt.code===4003){showClosed('Authentifizierung fehlgeschlagen.');return;}
    setStatus('disconnected','VERBINDUNG GETRENNT …');scheduleReconnect();
  });
  ws.addEventListener('error',()=>setStatus('disconnected','VERBINDUNGSFEHLER'));
}

// ── Beenden ───────────────────────────────────────────────────────────────────
$('btn-end').addEventListener('click',()=>{
  if(!confirm('Chat wirklich beenden? Der Raum wird für beide gelöscht.'))return;
  intentionalClose=true;cancelReconnect();cleanupCall();
  if(ws?.readyState===1)ws.send(JSON.stringify({type:'end'}));
  showClosed('Du hast den Chat beendet.');
});

// ── Neuer Chat ────────────────────────────────────────────────────────────────
$('btn-new').addEventListener('click',()=>{
  intentionalClose=true;cancelReconnect();stopKeepalive();cleanupCall();
  for(const t of sdTimers.values())clearInterval(t);sdTimers.clear();
  cryptoKey=null;roomId=null;ws=null;pendingRoomLink=null;
  partnerConnected=typingActive=sdTextEnabled=false;
  pendingPwHash=null;reconnectAttempts=0;intentionalClose=false;
  clearInterval(countdownInterval);
  $('messages').innerHTML='';myMsgs.clear();
  ['typing-indicator','countdown-wrap','sd-compose-row','recording-bar','video-rec-bar','call-bar','call-incoming'].forEach(id=>{const el=$(id);if(el){el.style.display='none';el.classList?.remove('active');}});
  $('btn-sd-toggle').classList.remove('active');
  ['reply-preview','edit-bar'].forEach(id=>{const el=$(id);if(el)el.style.display='none';});
  $('reconnect-banner').className='';$('sealed-banner').classList.remove('visible');
  $('pw-input').value='';$('pw-strength-fill').style.width='0';
  if($('sender-name'))$('sender-name').value='';
  if($('copy-notice-big'))$('copy-notice-big').textContent='';
  if($('btn-copy-link'))$('btn-copy-link').style.display='none';
  enableInput(false);
  const b=$('partner-banner');if(b)b.style.display='none';
  history.replaceState(null,'','/');showScreen('home');
  $('btn-create').disabled=false;$('btn-create').textContent='Sicheren Chat erstellen';
});

function showClosed(reason){
  intentionalClose=true;cancelReconnect();stopKeepalive();clearInterval(countdownInterval);cleanupCall();
  for(const t of sdTimers.values())clearInterval(t);
  if(ws?.readyState===1)try{ws.close();}catch{}
  ws=null;$('closed-reason').textContent=reason||'Raum gelöscht.';showScreen('closed');
}
function closedReason(code){
  return{user_ended:'Der Gesprächspartner hat den Chat beendet.',inactivity:'Raum nach 2 Stunden geschlossen.',all_left:'Alle Teilnehmer haben den Raum verlassen.'}[code]||'Raum geschlossen.';
}

// ── Start ─────────────────────────────────────────────────────────────────────
(async()=>{
  initWatermark();
  initAudioOutput();
  initTray();
  $('btn-extend')?.addEventListener('click', () => {
    if(ws?.readyState===1) ws.send(JSON.stringify({type:'extend'}));
  });
  const h = await initFromFragment();
  // Ab hier ist das Skript komplett ausgewertet — die Konstanten der
  // Einmal-Nachricht sind initialisiert und duerfen benutzt werden.
  initNoteUI();
  if(!h){
    const n = await initNoteFromFragment();
    if(!n) showScreen('home');
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// ── EINMAL-NACHRICHT ──────────────────────────────────────────────────────────
// Selbstzerstörende Einweg-Nachricht. Eigener Modus neben dem Chat, teilt sich
// mit ihm nur Optik und Krypto-Prinzip: Schlüssel im URL-Fragment, Server sieht
// ausschließlich Ciphertext.
// ══════════════════════════════════════════════════════════════════════════════

screens.noteDone = $('screen-note-done');
screens.noteRead = $('screen-note-read');

const NOTE_MAX_CHARS = 10000;
const NOTE_GLYPHS    = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎ0123456789ABCDEF<>/|=+*#$%&';

let noteData = { id:null, key:null, link:null, hasPassword:false, burn:true, expiresAt:0, plain:null };

// ── Base64 in Bloecken — schuetzt vor RangeError bei langen Nachrichten ───────
function noteBytesToB64(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}
function noteB64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Krypto — eigener Schluessel, damit ein offener Chat nicht gestoert wird ───
async function noteEncrypt(text, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, new TextEncoder().encode(text));
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv); buf.set(new Uint8Array(ct), 12);
  return noteBytesToB64(buf);
}
async function noteDecrypt(b64, key) {
  const buf = noteB64ToBytes(b64);
  const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv: buf.slice(0,12) }, key, buf.slice(12));
  return new TextDecoder().decode(pt);
}

// ── Text aufbereiten ─────────────────────────────────────────────────────────
// Reihenfolge zwingend: Smileys auf Rohtext, dann escapen, dann verlinken.
// So kann kein HTML aus der Nachricht in die Seite gelangen.
const NOTE_SMILEYS = [
  [/:-?\)/g, '🙂'], [/:-?\(/g, '🙁'], [/;-?\)/g, '😉'], [/:-?D/g, '😄'],
  [/:-?P/g, '😛'], [/:-?[oO]/g, '😮'], [/:'\(/g, '😢'], [/<3/g, '❤️'],
];
function noteSmileys(s) {
  // Nur am Wortanfang ersetzen, damit https:// und Uhrzeiten unangetastet bleiben
  return s.replace(/(^|\s)([:;]-?[)(DPoO]|:'\(|<3)/g, (m, lead, sym) => {
    for (const [re, emo] of NOTE_SMILEYS) { re.lastIndex = 0; if (new RegExp('^(?:' + re.source + ')$').test(sym)) return lead + emo; }
    return m;
  });
}
function noteEscapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function noteRenderBody(text) {
  const escaped = noteEscapeHtml(noteSmileys(text));
  return escaped.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/g, (raw) => {
    let url = raw, tail = '';
    const trailing = url.match(/[.,;:!?)\]]+$/);
    if (trailing) { tail = trailing[0]; url = url.slice(0, -tail.length); }
    if (!url) return raw;
    const href = url.startsWith('www.') ? 'https://' + url : url;
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer nofollow">' + url + '</a>' + tail;
  });
}

// ── Zeitangaben ──────────────────────────────────────────────────────────────
function noteFmtWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' })
       + ' um ' + d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' }) + ' Uhr';
}
function noteFmtRemaining(ts) {
  const ms = ts - Date.now();
  if (ms <= 0) return 'abgelaufen';
  const h = Math.round(ms / 3600000);
  if (h < 1)  return 'in ' + Math.max(1, Math.round(ms / 60000)) + ' Minuten';
  if (h < 48) return 'in ' + h + ' Stunden';
  return 'in ' + Math.round(h / 24) + ' Tagen';
}

// ── Modus-Umschalter ─────────────────────────────────────────────────────────
function setHomeMode(mode) {
  const isNote = mode === 'note';
  $('mode-chat').classList.toggle('active', !isNote);
  $('mode-note').classList.toggle('active',  isNote);
  $('mode-chat').setAttribute('aria-selected', String(!isNote));
  $('mode-note').setAttribute('aria-selected', String(isNote));
  $('pane-chat').classList.toggle('active', !isNote);
  $('pane-note').classList.toggle('active',  isNote);
  $('home-sub').textContent = isNote
    ? 'Einweg-Nachricht · zerstört sich nach dem Lesen'
    : 'Privater Einmal-Chat · E2E-verschlüsselt';
  screens.home.scrollTop = 0;
}

// ── Verfassen ────────────────────────────────────────────────────────────────
function updateNoteSummary() {
  const hours = parseInt($('note-ttl').value, 10);
  const burn  = $('note-burn').checked;
  const hasPw = !!$('note-pw').value;
  const when  = noteFmtWhen(Date.now() + hours * 3600000);
  let s = burn
    ? 'Wird beim <strong>ersten Öffnen</strong> gelöscht — spätestens am <strong>' + when + '</strong>.'
    : 'Bleibt bis <strong>' + when + '</strong> lesbar, danach wird sie gelöscht.';
  if (hasPw) s += ' Zum Öffnen ist zusätzlich das Passwort nötig.';
  $('note-summary').innerHTML = s;
}

function updateNoteCounter() {
  const len = $('note-text').value.length;
  const meter = $('note-count').parentElement;
  $('note-count').textContent = len.toLocaleString('de-DE');
  meter.classList.toggle('near', len > NOTE_MAX_CHARS * 0.9 && len < NOTE_MAX_CHARS);
  meter.classList.toggle('full', len >= NOTE_MAX_CHARS);
  $('btn-note-create').disabled = $('note-text').value.trim().length === 0;
}

// Laesst eine Stufe mindestens so lange stehen, dass man sie lesen kann.
// Verschluesseln dauert oft nur Millisekunden — ohne Mindestdauer blitzt die
// Anzeige nur auf und der Bildschirm springt um.
function mitMindestdauer(arbeit, ms) {
  return Promise.all([arbeit, new Promise(r => setTimeout(r, ms))]).then(a => a[0]);
}

async function createNote() {
  const btn  = $('btn-note-create');
  const face = btn.querySelector('.cta-face');
  const text = $('note-text').value;
  if (!text.trim()) return;

  // Nicht btn.textContent schreiben — das loescht Schloss, Beschriftung und
  // Pfeil aus dem Knopf, und zwar dauerhaft.
  const beschriftung = face.textContent;
  const ruhig = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const halt  = ruhig ? 0 : 380;
  const stufe = t => { face.textContent = t; };

  btn.disabled = true;
  btn.classList.remove('done', 'fehler');
  btn.classList.add('busy');

  try {
    stufe('Schlüssel wird erzeugt');
    const { key, b64url } = await mitMindestdauer(generateKey(), halt);
    window.secShowKey && secShowKey(b64url);

    stufe('Text wird verschlüsselt');
    const payload = await mitMindestdauer(noteEncrypt(text, key), halt);
    window.secLog && window.secLog('Nachricht verschlüsselt', 'AES-256');

    const pwPlain  = $('note-pw').value;
    const pwHash   = pwPlain ? await hashPassword(pwPlain) : null;
    const ttlHours = parseInt($('note-ttl').value, 10);
    const burn     = $('note-burn').checked;

    stufe('Wird versiegelt');
    const res = await mitMindestdauer(fetch('/api/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, pwHash, ttlHours, burn }),
    }), halt);
    if (res.status === 429) throw new Error('Zu viele Nachrichten in kurzer Zeit. Versuch es in ein paar Minuten noch einmal.');
    if (res.status === 503) throw new Error('Der Server ist gerade voll. Versuch es später noch einmal.');
    if (!res.ok)            throw new Error('Die Nachricht konnte nicht gespeichert werden.');

    const data = await res.json();

    // Der Buegel rastet ein und der Knopf blitzt auf — kurz stehen lassen,
    // damit man es sieht, dann kommt der Link.
    btn.classList.remove('busy');
    btn.classList.add('done');
    stufe('Versiegelt');
    window.secLog && window.secLog('Nachricht hinterlegt', String(data.noteId).slice(0, 8) + '…');
    if (!ruhig) await new Promise(r => setTimeout(r, 560));

    showNoteDone(location.origin + '/n/' + data.noteId + '#' + b64url, data);

    // Klartext nicht im Formular stehen lassen
    $('note-text').value = '';
    $('note-pw').value   = '';
    $('note-pw-fill').style.width = '0';
    updateNoteCounter();
    updateNoteSummary();
  } catch (e) {
    // Kein nativer Dialog — der passt weder zur Gestaltung noch zum Ablauf.
    // Der kurze Hinweis steht im Knopf, der volle Grund in der Sicherheitslage.
    const grund = (e && e.message) || 'Die Nachricht konnte nicht erstellt werden.';
    window.secLog && window.secLog('Fehlgeschlagen', grund);
    btn.classList.remove('busy', 'done');
    btn.classList.add('fehler');
    stufe('Fehlgeschlagen');
    await new Promise(r => setTimeout(r, 2400));
  } finally {
    btn.classList.remove('busy', 'done', 'fehler');
    face.textContent = beschriftung;
    btn.disabled = false;
    updateNoteCounter();
  }
}

// ── Link-Screen ──────────────────────────────────────────────────────────────
function noteShareText(link) {
  return 'Ich habe dir eine verschlüsselte Nachricht hinterlegt. Sie lässt sich nur einmal öffnen:\n' + link;
}

function showNoteDone(link, data) {
  noteData.link = link;

  // Den Schluessel im Link sichtbar machen. Alles hinter der Raute ist der
  // Schluessel — er geht nie an den Server. Als Satz steht das schnell da und
  // wird ueberlesen; abgesetzt sieht man es.
  const box = $('note-link-box');
  const r = link.indexOf('#');
  box.textContent = '';
  if (r < 0) {
    box.textContent = link;
  } else {
    const basis = document.createElement('span');
    basis.className = 'lk-base';
    basis.textContent = link.slice(0, r + 1);
    const schluessel = document.createElement('span');
    schluessel.className = 'lk-key';
    schluessel.textContent = link.slice(r + 1);
    box.appendChild(basis);
    box.appendChild(schluessel);
  }

  const share = encodeURIComponent(noteShareText(link));
  $('share-wa').href = 'https://wa.me/?text=' + share;
  $('share-tg').href = 'https://t.me/share/url?url=' + encodeURIComponent(link)
                     + '&text=' + encodeURIComponent('Verschlüsselte Nachricht — nur einmal zu öffnen');

  // Streifen-Schreibweise wie auf der Startseite, mit Mittelpunkten getrennt
  $('note-done-info').textContent = data.burn
    ? 'Einmal lesbar · Zerstört sich beim Öffnen · Ungelesen weg ' + noteFmtRemaining(data.expiresAt)
    : 'Mehrfach lesbar · Läuft ab ' + noteFmtWhen(data.expiresAt);

  noteCopyFace('Link kopieren', false);
  showScreen('noteDone');

  // Direkt in die Zwischenablage — der haeufigste naechste Schritt
  navigator.clipboard && navigator.clipboard.writeText(link)
    .then(() => noteCopyFace('Link kopiert', true))
    .catch(() => {});
}

// Beschriftung des Kopier-Knopfs. Nicht textContent des Knopfes schreiben —
// das loescht Schloss, Beschriftung und Pfeil.
function noteCopyFace(text, fertig) {
  const btn = $('btn-note-copy');
  if (!btn) return;
  const face = btn.querySelector('.cta-face');
  if (face) face.textContent = text; else btn.textContent = text;
  btn.classList.toggle('done', !!fertig);
}


// ── Lesen ────────────────────────────────────────────────────────────────────
function noteShowState(which) {
  for (const id of ['note-sealed', 'note-revealed', 'note-gone']) {
    $(id).hidden = (id !== 'note-' + which);
  }
}

function showNoteGone(reason) {
  noteShowState('gone');
  if (reason) $('note-gone-reason').textContent = reason;
  showScreen('noteRead');
  const titel = document.querySelector('#note-gone .gone-title');
  if (titel) revealDecoded(titel, 'Nichts mehr da', 'Nichts mehr da');
}


// Signature: der Text loest sich aus dem Rauschen heraus — zeigt, was
// technisch gerade passiert, statt es nur zu behaupten.
function revealDecoded(el, text, finalHtml) {
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || text.length > 1500) { el.innerHTML = finalHtml; return; }

  const chars = Array.from(text);
  const total = chars.length;
  const FRAMES = 26;
  let frame = 0;
  el.classList.add('decoding');
  const timer = setInterval(() => {
    frame++;
    const revealed = Math.floor(total * frame / FRAMES);
    let out = '';
    for (let i = 0; i < total; i++) {
      const c = chars[i];
      if (i < revealed || c === '\n' || c === ' ') out += c;
      else out += NOTE_GLYPHS[Math.floor(Math.random() * NOTE_GLYPHS.length)];
    }
    el.textContent = out;
    if (frame >= FRAMES) {
      clearInterval(timer);
      el.classList.remove('decoding');
      el.innerHTML = finalHtml;
    }
  }, 28);
}

function noteReadError(msg) {
  const el = $('note-read-error');
  el.textContent = msg;
  el.hidden = false;
}

async function openNote() {
  const btn = $('btn-note-open');
  $('note-read-error').hidden = true;

  if (noteData.hasPassword && !$('note-read-pw').value) {
    noteReadError('Bitte gib das Passwort ein.');
    $('note-read-pw').focus();
    return;
  }

  // Beschriftung in .cta-face — btn.textContent wuerde Schloss und Pfeil
  // aus dem Knopf loeschen.
  const face = btn.querySelector('.cta-face');
  const label = face ? face.textContent : btn.textContent;
  const setze = t => { if (face) face.textContent = t; else btn.textContent = t; };
  const ruhig = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const halt  = ruhig ? 0 : 340;

  btn.disabled = true;
  btn.classList.add('busy');   // der Buegel faehrt hoch, das Schloss geht auf
  setze('Wird geholt');
  try {
    const body = {};
    if (noteData.hasPassword) body.pwHash = await hashPassword($('note-read-pw').value);

    const res = await mitMindestdauer(fetch('/api/note/' + noteData.id + '/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), halt);

    if (res.status === 401) { noteReadError('Falsches Passwort.'); $('note-read-pw').select(); return; }
    if (res.status === 404) { showNoteGone(); return; }
    if (!res.ok)            { noteReadError('Der Server antwortet nicht. Versuch es gleich noch einmal.'); return; }

    const data = await res.json();
    setze('Wird entschlüsselt');
    if (!ruhig) await new Promise(r => setTimeout(r, halt));
    let plain;
    try {
      plain = await noteDecrypt(data.payload, noteData.key);
    } catch {
      noteReadError('Entschlüsseln fehlgeschlagen — der Schlüssel im Link passt nicht zu dieser Nachricht.');
      return;
    }

    noteData.plain = plain;
    // Jetzt ist die Nachricht geholt — der Schluessel darf aus der URL
    // verschwinden, ohne dass ein Neuladen vorher Schaden anrichtet.
    history.replaceState(null, '', location.pathname);
    noteShowState('revealed');
    $('note-destroyed-note').textContent = data.burned
      ? 'Diese Nachricht ist jetzt vom Server gelöscht. Sie lässt sich kein zweites Mal öffnen.'
      : 'Diese Nachricht bleibt bis ' + noteFmtWhen(data.expiresAt) + ' abrufbar.';
    revealDecoded($('note-body'), plain, noteRenderBody(plain));
  } catch {
    noteReadError('Keine Verbindung zum Server.');
  } finally {
    btn.classList.remove('busy');
    setze(label);
    btn.disabled = false;
  }
}

async function initNoteFromFragment() {
  const match = location.pathname.match(/^\/n\/([a-f0-9]{32})$/);
  if (!match) return false;

  showScreen('noteRead');
  noteShowState('sealed');

  const frag = location.hash.slice(1);
  if (!frag) { showNoteGone('Der Link ist unvollständig — der Schlüssel hinter dem # fehlt.'); return true; }

  noteData.id = match[1];
  try { noteData.key = await importKey(frag); }
  catch { showNoteGone('Der Schlüssel in diesem Link ist ungültig.'); return true; }

  try {
    const res = await fetch('/api/note/' + noteData.id);
    if (!res.ok) { showNoteGone(); return true; }
    const d = await res.json();
    noteData.hasPassword = d.hasPassword;
    noteData.burn        = d.burn;
    noteData.expiresAt   = d.expiresAt;

    $('note-read-pwgate').hidden = !d.hasPassword;
    $('note-lead').innerHTML = d.burn
      ? 'Du kannst sie <strong>einmal</strong> öffnen. Danach ist sie vom Server gelöscht.'
      : 'Sie bleibt bis zum Ablauf der Frist lesbar.';
    $('note-read-expiry').textContent = d.burn
      ? 'Ungeöffnet verschwindet sie ' + noteFmtRemaining(d.expiresAt) + '.'
      : 'Läuft ab am ' + noteFmtWhen(d.expiresAt) + '.';
    if (d.hasPassword) $('note-read-pw').focus();
  } catch {
    showNoteGone('Keine Verbindung zum Server.');
  }
  return true;
}

// ── Verdrahtung ──────────────────────────────────────────────────────────────
function initNoteUI() {
  $('mode-chat').addEventListener('click', () => setHomeMode('chat'));
  $('mode-note').addEventListener('click', () => setHomeMode('note'));

  // Pfeiltasten zwischen den beiden Tabs
  for (const id of ['mode-chat', 'mode-note']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const next = id === 'mode-chat' ? 'mode-note' : 'mode-chat';
      setHomeMode(next === 'mode-note' ? 'note' : 'chat');
      $(next).focus();
    });
  }

  $('note-text').addEventListener('input', updateNoteCounter);
  $('note-text').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); createNote(); }
  });
  $('note-ttl').addEventListener('change', updateNoteSummary);
  $('note-burn').addEventListener('change', updateNoteSummary);

  $('note-pw').addEventListener('input', function () {
    const pw = this.value; let s = 0;
    if (pw.length > 6) s++; if (pw.length > 10) s++;
    if (/[A-Z]/.test(pw)) s++; if (/[0-9]/.test(pw)) s++; if (/[^a-zA-Z0-9]/.test(pw)) s++;
    const fill = $('note-pw-fill');
    fill.style.width = (s / 5 * 100) + '%';
    fill.style.background = ['', '#ff3333', '#ff8800', '#ffcc00', '#88cc00', '#00ff41'][s] || '';
    updateNoteSummary();
  });

  [['note-pw', 'note-pw-toggle'], ['note-read-pw', 'note-read-pw-toggle']].forEach(([inp, btn]) => {
    $(btn).addEventListener('click', () => {
      const el = $(inp);
      el.type = el.type === 'password' ? 'text' : 'password';
      $(btn).setAttribute('aria-label', el.type === 'password' ? 'Passwort anzeigen' : 'Passwort verbergen');
    });
  });

  $('btn-note-create').addEventListener('click', createNote);

  $('btn-note-copy').addEventListener('click', async () => {
    if (!noteData.link) return;
    try {
      await navigator.clipboard.writeText(noteData.link);
      noteCopyFace('Link kopiert', true);
      setTimeout(() => noteCopyFace('Link kopieren', false), 2500);
    } catch {
      const r = document.createRange();
      r.selectNodeContents($('note-link-box'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      $('note-done-info').textContent = 'Markiert — jetzt mit Strg+C bzw. langem Tippen kopieren.';
    }
  });

  $('btn-note-qr').addEventListener('click', () => { if (noteData.link) showQR(noteData.link); });

  $('btn-note-again').addEventListener('click', () => {
    noteData = { id:null, key:null, link:null, hasPassword:false, burn:true, expiresAt:0, plain:null };
    history.replaceState(null, '', '/');
    showScreen('home');
    setHomeMode('note');
    $('note-text').focus();
  });

  $('btn-note-open').addEventListener('click', openNote);
  $('note-read-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') openNote(); });

  $('btn-note-copy-text').addEventListener('click', async () => {
    if (!noteData.plain) return;
    try {
      await navigator.clipboard.writeText(noteData.plain);
      $('btn-note-copy-text').textContent = '✓ Kopiert';
      setTimeout(() => { $('btn-note-copy-text').textContent = 'Text kopieren'; }, 2500);
    } catch {}
  });

  for (const id of ['btn-note-reply', 'btn-note-gone-new']) {
    $(id).addEventListener('click', () => {
      history.replaceState(null, '', '/');
      showScreen('home');
      setHomeMode('note');
      $('note-text').focus();
    });
  }

  updateNoteCounter();
  updateNoteSummary();
}

// ══════════════════════════════════════════════════════════════════════════════
// ── SICHERHEITSPULT ───────────────────────────────────────────────────────────
// Zeigt ausschließlich gemessene Werte. Ein Schild, das immer grün leuchtet,
// wäre bei einer Verschlüsselungs-App der teuerste Fehler — deshalb steht hier
// nichts, was nicht tatsächlich abgefragt wurde.
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  const logEl = $('sec-log');
  if (!logEl) return;

  function stamp() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0') + ':' +
           String(d.getSeconds()).padStart(2, '0');
  }
  function secLog(text, value) {
    const row = document.createElement('div');
    const t = document.createElement('span'); t.className = 't'; t.textContent = stamp();
    row.appendChild(t);
    row.appendChild(document.createTextNode(' ' + text));
    if (value) {
      const v = document.createElement('span'); v.className = 'v'; v.textContent = ' ' + value;
      row.appendChild(v);
    }
    logEl.appendChild(row);
    while (logEl.children.length > 12) logEl.removeChild(logEl.firstChild);
  }

  // 'ok' grün, 'bad' rot, alles andere neutral — ein noch nicht erzeugter
  // Schlüssel ist kein Fehlerzustand und darf nicht rot leuchten.
  function led(id, state, value) {
    const el = $(id); if (!el) return;
    el.classList.remove('ok', 'bad');
    if (state === 'ok') el.classList.add('ok');
    else if (state === 'bad') el.classList.add('bad');
    el.querySelector('b').textContent = value;
  }

  const hasCrypto = !!(window.crypto && crypto.subtle);
  let stored = 0;
  try { stored = localStorage.length + sessionStorage.length; } catch { stored = -1; }

  led('led-ctx', isSecureContext ? 'ok' : 'bad', isSecureContext ? 'sicher' : 'unsicher');
  led('led-crypto', hasCrypto ? 'ok' : 'bad', hasCrypto ? 'bereit' : 'fehlt');
  led('led-store', stored === 0 ? 'ok' : 'bad',
      stored === 0 ? 'leer' : (stored < 0 ? 'gesperrt' : stored + ' Einträge'));
  led('led-key', 'idle', 'bereit');

  secLog('Kontext geprüft', isSecureContext ? 'sicher' : 'UNSICHER');
  secLog('WebCrypto', hasCrypto ? 'verfügbar' : 'FEHLT');
  secLog('Browserspeicher', stored === 0 ? '0 Einträge' : stored + ' Einträge');
  if (!isSecureContext) secLog('Ohne HTTPS ist keine Verschlüsselung möglich');

  // Fingerabdruck: vier Hex-Paare aus dem SHA-256 des Schlüssels. Beide Seiten
  // sehen dieselben vier Blöcke und können sie vergleichen — so wie Signal
  // seine Sicherheitsnummern. Der Schlüssel selbst verlässt den Browser nie.
  window.secLog = secLog;

  window.secShowKey = async function (b64url) {
    try {
      const raw = Uint8Array.from(
        atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const hash = await crypto.subtle.digest('SHA-256', raw);
      const parts = Array.from(new Uint8Array(hash).slice(0, 4))
        .map(x => x.toString(16).padStart(2, '0').toUpperCase());
      const cells = $('sec-fp').children;
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Laufende Zeitgeber zuerst stoppen: bei einem zweiten Aufruf haetten
      // sich sonst mehrere Schleifen ueberlagert und die Zellen nie beruhigt.
      if (window.__fpTimers) window.__fpTimers.forEach(clearInterval);
      window.__fpTimers = [];
      for (let i = 0; i < cells.length; i++) {
        const zelle = cells[i], wert = parts[i];
        if (reduce) { zelle.textContent = wert; zelle.classList.add('set'); continue; }
        let n = 0;
        const t = setInterval(() => {
          if (++n > 6 + i * 3) {
            clearInterval(t);
            zelle.textContent = wert;
            zelle.classList.add('set');
            return;
          }
          zelle.textContent = randGlyph() + randGlyph();
        }, 40);
        window.__fpTimers.push(t);
      }
      led('led-key', 'ok', 'AES-256');
      secLog('Schlüssel erzeugt', parts.join(' '));
      secLog('Schlüssel bleibt im Browser', 'nicht gesendet');
    } catch (e) {
      secLog('Fingerabdruck fehlgeschlagen', e.name || 'Fehler');
    }
  };
  function randGlyph() {
    const g = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789ABCDEF';
    return g[Math.floor(Math.random() * g.length)];
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// ── STARTSEITE: Bedienlogik aus dem abgenommenen Entwurf ──────────────────────
// Das Markup der Startseite stammt unverändert aus dem Entwurf. Diese Schicht
// bedient es: gleitender Umschalter, eigenes Auswahlfeld, Startsequenz.
// Die Werte fließen weiter über #note-ttl, damit die vorhandene Notiz-Logik
// unverändert weiterläuft.
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  const fill = $('mode-fill'), pointer = $('mode-pointer');
  if (!fill) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tabs  = { note: $('mode-note'), chat: $('mode-chat') };
  const panes = { note: $('pane-note'), chat: $('pane-chat') };
  let current = 'note';

  function place() {
    const wrap = document.querySelector('.modes-wrap').getBoundingClientRect();
    const r = tabs[current].getBoundingClientRect();
    fill.style.left  = (r.left - wrap.left) + 'px';
    fill.style.width = r.width + 'px';
    fill.classList.toggle('right', current === 'chat');
    pointer.style.left = (r.left - wrap.left + r.width / 2 - 8) + 'px';
  }
  function apply(m) {
    current = m;
    for (const k in tabs) {
      tabs[k].setAttribute('aria-selected', String(k === m));
      panes[k].classList.toggle('on', k === m);
    }
    const sub = $('home-sub');
    if (sub) sub.textContent = m === 'chat'
      ? 'Privater Einmal-Chat · E2E-verschlüsselt'
      : 'Einweg-Nachricht · zerstört sich beim Lesen';
    place();
    const el = tabs[m];
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    setTimeout(() => el.classList.remove('pop'), 480);
  }
  tabs.note.addEventListener('click', () => current !== 'note' && apply('note'));
  tabs.chat.addEventListener('click', () => current !== 'chat' && apply('chat'));
  addEventListener('resize', place);
  place();
  if (document.fonts) document.fonts.ready.then(place);

  // ── Eigenes Auswahlfeld ───────────────────────────────────────────────────
  // Das native <select> öffnet auf iOS ein graues Systemrad, das sich nicht
  // gestalten lässt. Die Liste liegt außerhalb des Panels, weil der clip-path
  // des Rahmens sie sonst abschneiden würde.
  const pickBtn = $('ttl-btn'), pickList = $('ttl-list'), pickValue = $('ttl-value'), ttlInput = $('note-ttl');
  if (pickBtn && pickList) {
    const opts = Array.prototype.slice.call(pickList.querySelectorAll('[role="option"]'));
    let here = opts.findIndex(o => o.getAttribute('aria-selected') === 'true');

    function placeList() {
      const r = pickBtn.getBoundingClientRect();
      const w = Math.max(r.width, 152);
      pickList.style.width = w + 'px';
      pickList.style.left = Math.round(Math.min(Math.max(8, r.right - w), innerWidth - w - 8)) + 'px';
      const h = pickList.offsetHeight;
      pickList.style.top = (innerHeight - r.bottom - 10 >= h)
        ? Math.round(r.bottom + 6) + 'px'
        : Math.round(Math.max(8, r.top - h - 6)) + 'px';
    }
    const markHere = i => opts.forEach((o, n) => o.classList.toggle('here', n === i));
    function outside(e){ if (!pickList.contains(e.target) && !pickBtn.contains(e.target)) close(false); }
    function open() {
      pickList.hidden = false; placeList();
      pickBtn.setAttribute('aria-expanded', 'true'); markHere(here);
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('touchstart', outside, true);
      addEventListener('resize', placeList); addEventListener('scroll', placeList, true);
    }
    function close(back) {
      pickList.hidden = true; pickBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('touchstart', outside, true);
      removeEventListener('resize', placeList); removeEventListener('scroll', placeList, true);
      if (back) pickBtn.focus();
    }
    function choose(i) {
      const o = opts[i]; if (!o) return;
      opts.forEach(x => x.setAttribute('aria-selected', 'false'));
      o.setAttribute('aria-selected', 'true');
      here = i;
      pickValue.textContent = o.textContent;
      // Der Wert geht über das versteckte Feld an die bestehende Notiz-Logik
      ttlInput.value = o.getAttribute('data-h');
      ttlInput.dispatchEvent(new Event('change', { bubbles: true }));
      close(true);
    }
    pickBtn.addEventListener('click', () => pickList.hidden ? open() : close(false));
    pickBtn.addEventListener('keydown', e => {
      if (['ArrowDown','ArrowUp','Enter',' '].includes(e.key)) { e.preventDefault(); open(); pickList.focus(); }
    });
    pickList.tabIndex = -1;
    pickList.addEventListener('click', e => {
      const li = e.target.closest('[role="option"]'); if (li) choose(opts.indexOf(li));
    });
    pickList.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(here); return; }
      if (e.key === 'Home') { e.preventDefault(); here = 0; markHere(here); return; }
      if (e.key === 'End')  { e.preventDefault(); here = opts.length - 1; markHere(here); return; }
      const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      here = Math.max(0, Math.min(opts.length - 1, here + d));
      markHere(here);
    });
  }

  // ── Startsequenz: der Schriftzug setzt sich aus Zeichenrauschen zusammen ──
  const brand = document.querySelector('#screen-home .brand');
  if (brand && !reduce) {
    const G = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789ABCDEF';
    const real = brand.textContent, chars = real.split('');
    let f = 0;
    const t = setInterval(() => {
      f++;
      const shown = Math.floor(chars.length * f / 16);
      brand.textContent = chars.map((c, i) => i < shown ? c : G[Math.floor(Math.random() * G.length)]).join('');
      if (f >= 16) { clearInterval(t); brand.textContent = real; }
    }, 38);
  }
})();
