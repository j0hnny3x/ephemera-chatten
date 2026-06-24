'use strict';

const MAX_TEXT_LEN   = 4000;
const MAX_IMG_BYTES  = 2  * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMG_MAX_DIM    = 1600;
const IMG_QUALITY    = 0.82;
const WS_PROTO       = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ROOM_LIFETIME  = 2 * 60 * 60 * 1000;
const KEEPALIVE_MS   = 20 * 1000;
const RECONNECT_BASE = 2000;
const RECONNECT_MAX  = 30000;
const RECONNECT_TRIES= 10;
const REACTIONS      = ['👍','❤️','😂','😮','😢','🔥'];
const EDIT_WINDOW_MS = 30 * 1000;
const VIDEO_MAX_SEC  = 60;

let cryptoKey=null, ws=null, roomId=null;
let partnerConnected=false, intentionalClose=false;
let countdownInterval=null, keepaliveTimer=null, reconnectTimer=null;
let reconnectAttempts=0, typingTimer=null, typingActive=false;
let pendingPwHash=null, fontSize=16;
let mediaRecorder=null, audioChunks=[], recInterval=null, recSeconds=0;
let videoRecorder=null, videoChunks=[], videoRecInterval=null, videoRecSeconds=0;
let pendingMediaData=null, pendingMediaMime=null, pendingMediaType=null;
let replyToId=null, replyToText=null, editingId=null;
let sdTextEnabled=false, unread=0, roomExpiry=null;
let forwardSecretCounter=0, subKey=null;
let hasShownNewMsgDivider=false;
const myMsgs=new Map();
const sdTimers=new Map();

const $=id=>document.getElementById(id);
const screens={home:$('screen-home'),pw:$('screen-pw'),chat:$('screen-chat'),closed:$('screen-closed')};
function showScreen(n){
  for(const[k,el] of Object.entries(screens)) el.classList.toggle('active',k===n);
  // Scroll nach oben bei Home/PW/Closed
  if(n!=='chat') window.scrollTo(0,0);
}

// ── Matrix Canvas ─────────────────────────────────
function initMatrix(){
  const canvas=$('matrix-canvas');
  const ctx=canvas.getContext('2d');
  const resize=()=>{ canvas.width=window.innerWidth; canvas.height=window.innerHeight; };
  resize(); window.addEventListener('resize',resize);
  const chars='ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ01ABCDEF'.split('');
  const fs=14; let cols=Math.floor(canvas.width/fs);
  let drops=Array(cols).fill(1);
  window.addEventListener('resize',()=>{ cols=Math.floor(canvas.width/fs); drops=Array(cols).fill(1); });
  setInterval(()=>{
    ctx.fillStyle='rgba(0,0,0,0.06)';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    drops.forEach((y,i)=>{
      const c=chars[Math.floor(Math.random()*chars.length)];
      const g=Math.floor(Math.random()*120+135);
      ctx.fillStyle=`rgba(0,${g},${Math.floor(Math.random()*20)},${Math.random()*0.6+0.4})`;
      ctx.font=fs+'px monospace';
      ctx.fillText(c,i*fs,y*fs);
      if(y*fs>canvas.height&&Math.random()>0.972) drops[i]=0;
      drops[i]++;
    });
  },45);
}
initMatrix();

// ── Krypto ────────────────────────────────────────
async function generateKey(){
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  const raw=await crypto.subtle.exportKey('raw',key);
  const b64url=btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return{key,b64url};
}
async function importKey(b64url){
  const raw=Uint8Array.from(atob(b64url.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  return crypto.subtle.importKey('raw',raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function getEncryptKey(){
  const count=Math.floor(myMsgs.size/10);
  if(count>0&&count!==forwardSecretCounter){
    forwardSecretCounter=count;
    const raw=await crypto.subtle.exportKey('raw',cryptoKey);
    const cb=new Uint8Array(4); new DataView(cb.buffer).setUint32(0,count,false);
    const combined=new Uint8Array(raw.byteLength+4); combined.set(new Uint8Array(raw)); combined.set(cb,raw.byteLength);
    const hash=await crypto.subtle.digest('SHA-256',combined);
    subKey=await crypto.subtle.importKey('raw',hash,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  return{key:subKey||cryptoKey,counter:forwardSecretCounter};
}
async function encrypt(plaintext){
  const{key,counter}=await getEncryptKey();
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(plaintext));
  const buf=new Uint8Array(12+ct.byteLength); buf.set(iv); buf.set(new Uint8Array(ct),12);
  const out=new Uint8Array(4+buf.length); new DataView(out.buffer).setUint32(0,counter,false); out.set(buf,4);
  return btoa(String.fromCharCode(...out));
}
async function decrypt(b64){
  const all=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
  const counter=new DataView(all.buffer).getUint32(0,false);
  const buf=all.slice(4);
  let useKey=cryptoKey;
  if(counter>0){
    const raw=await crypto.subtle.exportKey('raw',cryptoKey);
    const cb=new Uint8Array(4); new DataView(cb.buffer).setUint32(0,counter,false);
    const combined=new Uint8Array(raw.byteLength+4); combined.set(new Uint8Array(raw)); combined.set(cb,raw.byteLength);
    const hash=await crypto.subtle.digest('SHA-256',combined);
    useKey=await crypto.subtle.importKey('raw',hash,{name:'AES-GCM',length:256},false,['decrypt']);
  }
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:buf.slice(0,12)},useKey,buf.slice(12));
  return new TextDecoder().decode(pt);
}
async function hashPassword(pw){
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ── PW Stärke ────────────────────────────────────
$('pw-input').addEventListener('input',function(){
  const pw=this.value; let s=0;
  if(pw.length>6)s++;if(pw.length>10)s++;if(/[A-Z]/.test(pw))s++;if(/[0-9]/.test(pw))s++;if(/[^a-zA-Z0-9]/.test(pw))s++;
  const fill=$('pw-strength-fill');
  fill.style.width=(s/5*100)+'%';
  fill.style.background=['','#ff3333','#ff8800','#ffcc00','#88cc00','#00ff41'][s]||'';
});

// ── PW Toggles ────────────────────────────────────
[['pw-input','pw-toggle'],['pw-join','pw-join-toggle']].forEach(([inp,btn])=>{
  $(btn).addEventListener('click',()=>{const el=$(inp);el.type=el.type==='password'?'text':'password';});
});

// ── Bild komprimieren ─────────────────────────────
async function compressImage(file){
  return new Promise((resolve,reject)=>{
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
          if(!blob){reject(new Error('fail'));return;}
          if(blob.size<=MAX_IMG_BYTES||q<0.3){
            const r2=new FileReader(); r2.onload=ev=>resolve({dataUrl:ev.target.result,mime:blob.type,size:blob.size}); r2.readAsDataURL(blob);
          }else{q-=0.1;tryC();}
        },'image/jpeg',q);
        tryC();
      };
      img.onerror=reject; img.src=e.target.result;
    };
    reader.onerror=reject; reader.readAsDataURL(file);
  });
}

// ── Sound ─────────────────────────────────────────
function playPing(){
  try{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(1100,ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(550,ctx.currentTime+0.1);
    gain.gain.setValueAtTime(0.1,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.18);
    osc.start(); osc.stop(ctx.currentTime+0.18);
  }catch{}
}
function vibrate(){try{navigator.vibrate?.(80);}catch{}}

// ── Tab Badge ─────────────────────────────────────
function bumpUnread(){
  if(document.visibilityState==='visible')return;
  unread++; document.title=`(${unread}) ephemera`;
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){unread=0;document.title='ephemera';}
});

// ── Countdown ─────────────────────────────────────
function startCountdown(createdAt){
  roomExpiry=createdAt+ROOM_LIFETIME;
  $('countdown-wrap').style.display='flex';
  const tick=()=>{
    const rem=roomExpiry-Date.now();
    if(rem<=0){$('countdown').textContent='0:00:00';return;}
    const h=Math.floor(rem/3600000),m=Math.floor(rem%3600000/60000),s=Math.floor(rem%60000/1000);
    $('countdown').textContent=`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    const el=$('countdown'); el.className='countdown-val';
    if(rem<10*60000)el.classList.add('critical');
    else if(rem<30*60000)el.classList.add('warning');
  };
  tick(); countdownInterval=setInterval(tick,1000);
}

// ── QR ────────────────────────────────────────────
function showQR(link){
  $('qr-canvas').innerHTML='';
  new QRCode($('qr-canvas'),{text:link,width:200,height:200,colorDark:'#00ff41',colorLight:'#0a0f0a',correctLevel:QRCode.CorrectLevel.M});
  $('qr-overlay').style.display='flex';
}
$('btn-qr-close').addEventListener('click',()=>$('qr-overlay').style.display='none');
$('btn-fs-close').addEventListener('click',()=>$('media-fullscreen').style.display='none');
function openFullscreen(type,src){
  $('fs-img').style.display='none'; $('fs-vid').style.display='none';
  if(type==='img'){$('fs-img').src=src;$('fs-img').style.display='block';}
  else{$('fs-vid').src=src;$('fs-vid').style.display='block';}
  $('media-fullscreen').style.display='flex';
}

// ── Keepalive ─────────────────────────────────────
function startKeepalive(){clearInterval(keepaliveTimer);keepaliveTimer=setInterval(()=>{if(ws?.readyState===1)ws.send(JSON.stringify({type:'ping'}));},KEEPALIVE_MS);}
function stopKeepalive(){clearInterval(keepaliveTimer);}

// ── Reconnect ─────────────────────────────────────
function scheduleReconnect(){
  if(intentionalClose)return;
  if(reconnectAttempts>=RECONNECT_TRIES){showClosed('Verbindung konnte nicht wiederhergestellt werden.');return;}
  const delay=Math.min(RECONNECT_BASE*Math.pow(1.5,reconnectAttempts),RECONNECT_MAX);
  reconnectAttempts++;
  const b=$('reconnect-banner'); b.className='visible';
  b.textContent=`> VERBINDUNG GETRENNT — Versuch ${reconnectAttempts}/${RECONNECT_TRIES} in ${Math.round(delay/1000)}s`;
  reconnectTimer=setTimeout(()=>{if(!intentionalClose&&roomId&&cryptoKey)openWebSocket();},delay);
}
function cancelReconnect(){clearTimeout(reconnectTimer);$('reconnect-banner').className='';}

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&roomId&&cryptoKey&&!intentionalClose){
    if(!ws||ws.readyState===WebSocket.CLOSED||ws.readyState===WebSocket.CLOSING){
      cancelReconnect(); reconnectAttempts=0; openWebSocket();
    }
  }
});

// ── Drag & Drop ───────────────────────────────────
const dropOverlay=$('drop-overlay');
dropOverlay.textContent='> DATEI HIER ABLEGEN';
document.addEventListener('dragover',e=>{e.preventDefault();dropOverlay.classList.add('visible');});
document.addEventListener('dragleave',e=>{if(!e.relatedTarget)dropOverlay.classList.remove('visible');});
document.addEventListener('drop',async e=>{
  e.preventDefault(); dropOverlay.classList.remove('visible');
  for(const file of [...(e.dataTransfer?.files||[])]) await handleFileOrImage(file);
});

// ── Nachrichten scrollen ──────────────────────────
function scrollMsgs(){
  const wrap=$('messages-wrap');
  wrap.scrollTop=wrap.scrollHeight;
}

// ── Partner Banner ────────────────────────────────
function setPartnerBanner(state){
  let b=$('partner-banner');
  if(!b){b=document.createElement('div');b.id='partner-banner';$('messages').insertBefore(b,$('messages').firstChild);}
  b.className=`partner-banner ${state}`;
  b.style.display=state==='hidden'?'none':'block';
  b.textContent=state==='online'?'> GESPRÄCHSPARTNER ONLINE':'> GESPRÄCHSPARTNER OFFLINE';
}

// ── Neue Nachrichten Divider ──────────────────────
function insertNewMsgDivider(){
  if(hasShownNewMsgDivider)return;
  hasShownNewMsgDivider=true;
  const div=document.createElement('div');
  div.className='new-msg-divider msg system';
  div.textContent='NEUE NACHRICHTEN';
  $('messages').appendChild(div);
}

// ── Emoji Picker ──────────────────────────────────
let emojiTargetId=null;
function showEmojiPicker(msgId,anchor){
  emojiTargetId=msgId;
  const picker=$('emoji-picker'),list=$('emoji-list');
  list.innerHTML='';
  REACTIONS.forEach(emoji=>{
    const btn=document.createElement('button'); btn.className='emoji-opt'; btn.textContent=emoji;
    btn.addEventListener('click',()=>{sendReaction(msgId,emoji);picker.style.display='none';});
    list.appendChild(btn);
  });
  const rect=anchor.getBoundingClientRect();
  picker.style.bottom=(window.innerHeight-rect.top+4)+'px';
  picker.style.left=Math.max(4,Math.min(rect.left,window.innerWidth-210))+'px';
  picker.style.top='auto';
  picker.style.display='block';
}
document.addEventListener('click',e=>{if(!$('emoji-picker').contains(e.target))$('emoji-picker').style.display='none';});

// ── Nachrichten-Blase ─────────────────────────────
function newMsgId(){return crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);}
function fmtTime(ts){const d=new Date(ts||Date.now());return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');}

function buildBubble(role,id){
  const wrap=document.createElement('div'); wrap.className=`msg ${role}`;
  if(id)wrap.dataset.id=id;
  const actions=document.createElement('div'); actions.className='msg-actions';
  const replyBtn=document.createElement('button'); replyBtn.className='msg-action-btn'; replyBtn.textContent='↩';
  replyBtn.addEventListener('click',()=>startReply(id,wrap)); actions.appendChild(replyBtn);
  const reactBtn=document.createElement('button'); reactBtn.className='msg-action-btn'; reactBtn.textContent='😊';
  reactBtn.addEventListener('click',e=>{e.stopPropagation();showEmojiPicker(id,reactBtn);}); actions.appendChild(reactBtn);
  wrap.appendChild(actions);
  return wrap;
}

function addMeta(wrap,role,id,ts,isPending){
  const meta=document.createElement('div'); meta.className='msg-meta';
  const time=document.createElement('span'); time.className='msg-time'; time.textContent=fmtTime(ts); meta.appendChild(time);
  if(role==='self'&&id){
    const readEl=document.createElement('span');
    readEl.className=isPending?'read-status read-pending':'read-status';
    readEl.textContent=isPending?'⏳':'✓'; meta.appendChild(readEl);
    myMsgs.set(id,{el:wrap,readEl});
    const ret=document.createElement('button'); ret.className='btn-retract'; ret.textContent='zurückziehen';
    ret.addEventListener('click',()=>retractMessage(id)); meta.appendChild(ret);
    const editBtn=document.createElement('button'); editBtn.className='btn-edit'; editBtn.textContent='✎';
    editBtn.addEventListener('click',()=>{
      const t=wrap.querySelector('.msg-text'); if(t)startEdit(id,t.textContent);
    }); meta.appendChild(editBtn);
  }
  const reacDiv=document.createElement('div'); reacDiv.className='msg-reactions'; reacDiv.id=`reactions-${id}`;
  wrap.appendChild(meta); wrap.appendChild(reacDiv);
  return meta;
}

function addTextMessage(text,role,id,ts,isPending,quoteId,quoteText,edited){
  const wrap=buildBubble(role,id);
  if(quoteText){const q=document.createElement('div');q.className='msg-quote';q.textContent=quoteText.slice(0,80)+(quoteText.length>80?'…':'');wrap.appendChild(q);}
  const body=document.createElement('div'); body.className='msg-body';
  const t=document.createElement('span'); t.className='msg-text'; t.textContent=text; body.appendChild(t); wrap.appendChild(body);
  const meta=addMeta(wrap,role,id,ts,isPending);
  if(edited){const ed=document.createElement('span');ed.className='edited-label';ed.textContent='(bearbeitet)';meta.prepend(ed);}
  finishMsg(wrap,role,id);
  if(role==='other'&&id&&ws?.readyState===1)ws.send(JSON.stringify({type:'read',id}));
  return wrap;
}

function addImageMessage(dataUrl,role,id,ts,isPending){
  const wrap=buildBubble(role,id);
  const img=document.createElement('img'); img.className='msg-img'; img.src=dataUrl; img.alt='Bild';
  img.addEventListener('click',()=>openFullscreen('img',dataUrl)); wrap.appendChild(img);
  addMeta(wrap,role,id,ts,isPending); finishMsg(wrap,role,id);
  if(role==='other'&&id&&ws?.readyState===1)ws.send(JSON.stringify({type:'read',id}));
  return wrap;
}

function addVideoMessage(dataUrl,role,id,ts,isPending){
  const wrap=buildBubble(role,id);
  const vid=document.createElement('video'); vid.className='msg-vid'; vid.src=dataUrl; vid.controls=true; vid.preload='metadata';
  vid.addEventListener('dblclick',()=>openFullscreen('vid',dataUrl)); wrap.appendChild(vid);
  addMeta(wrap,role,id,ts,isPending); finishMsg(wrap,role,id);
  if(role==='other'&&id&&ws?.readyState===1)ws.send(JSON.stringify({type:'read',id}));
  return wrap;
}

function addAudioMessage(dataUrl,role,id,ts,isPending){
  const wrap=buildBubble(role,id);
  const div=document.createElement('div'); div.className='msg-audio';
  const lbl=document.createElement('div'); lbl.className='audio-label'; lbl.textContent='> SPRACHNACHRICHT';
  const aud=document.createElement('audio'); aud.controls=true; aud.src=dataUrl; aud.preload='metadata';
  div.appendChild(lbl); div.appendChild(aud); wrap.appendChild(div);
  addMeta(wrap,role,id,ts,isPending); finishMsg(wrap,role,id);
  if(role==='other'&&id&&ws?.readyState===1)ws.send(JSON.stringify({type:'read',id}));
  return wrap;
}

function addFileMessage(dataUrl,filename,filesize,role,id,ts,isPending){
  const wrap=buildBubble(role,id);
  const div=document.createElement('div'); div.className='msg-file';
  const icon=document.createElement('div'); icon.className='file-icon'; icon.textContent='📄';
  const info=document.createElement('div'); info.className='file-info';
  const name=document.createElement('div'); name.className='file-name'; name.textContent=filename;
  const size=document.createElement('div'); size.className='file-size'; size.textContent=Math.round(filesize/1024)+' KB';
  info.appendChild(name); info.appendChild(size);
  const dl=document.createElement('a'); dl.href=dataUrl; dl.download=filename; dl.className='btn btn-ghost btn-dl'; dl.textContent='↓';
  div.appendChild(icon); div.appendChild(info); div.appendChild(dl); wrap.appendChild(div);
  addMeta(wrap,role,id,ts,isPending); finishMsg(wrap,role,id);
  if(role==='other'&&id&&ws?.readyState===1)ws.send(JSON.stringify({type:'read',id}));
  return wrap;
}

function addSystem(text){
  const el=document.createElement('div'); el.className='msg system'; el.textContent='// '+text;
  $('messages').appendChild(el); scrollMsgs();
}

function finishMsg(wrap){$('messages').appendChild(wrap);scrollMsgs();}

function markDelivered(id){
  const e=myMsgs.get(id);
  if(e&&e.readEl.textContent==='⏳'){e.readEl.textContent='✓';e.readEl.className='read-status';}
}

// ── Selbstlösch ───────────────────────────────────
function scheduleSelfDestruct(id,seconds){
  const el=$('messages').querySelector(`[data-id="${CSS.escape(id)}"]`); if(!el)return;
  let rem=seconds;
  const sdSpan=document.createElement('span'); sdSpan.className='sd-countdown'; sdSpan.textContent=`⏱${rem}s`;
  el.querySelector('.msg-meta')?.appendChild(sdSpan);
  const t=setInterval(()=>{
    rem--; sdSpan.textContent=`⏱${rem}s`;
    if(rem<=0){
      clearInterval(t); sdTimers.delete(id);
      el.classList.add('retracted');
      ['msg-body','msg-img','msg-audio','msg-vid','msg-file'].forEach(cls=>el.querySelector('.'+cls)?.remove());
      const ph=document.createElement('div'); ph.className='msg-body'; ph.textContent='[Nachricht gelöscht]';
      el.insertBefore(ph,el.querySelector('.msg-meta'));
      if(ws?.readyState===1)ws.send(JSON.stringify({type:'self_destruct_ack',id}));
    }
  },1000);
  sdTimers.set(id,t);
}

// ── Reaktionen ────────────────────────────────────
function sendReaction(msgId,emoji){
  if(!ws||ws.readyState!==1)return;
  ws.send(JSON.stringify({type:'reaction',id:newMsgId(),msgId,emoji}));
  applyReaction(msgId,emoji,true);
}
function applyReaction(msgId,emoji,isMine){
  const c=document.getElementById(`reactions-${msgId}`); if(!c)return;
  let found=null;
  for(const b of c.querySelectorAll('.reaction-badge'))if(b.dataset.emoji===emoji){found=b;break;}
  if(found){const cnt=parseInt(found.dataset.count||1)+1;found.dataset.count=cnt;found.textContent=emoji+(cnt>1?` ${cnt}`:'');if(isMine)found.classList.add('mine');}
  else{const b=document.createElement('button');b.className='reaction-badge'+(isMine?' mine':'');b.dataset.emoji=emoji;b.dataset.count=1;b.textContent=emoji;c.appendChild(b);}
}

// ── Reply ─────────────────────────────────────────
function startReply(id,el){
  replyToId=id;
  const t=el.querySelector('.msg-text'); replyToText=t?t.textContent:'[Medien]';
  $('reply-preview').style.display='block';
  $('reply-preview-text').textContent=replyToText.slice(0,80);
  $('msg-input').focus();
}
$('btn-reply-cancel').addEventListener('click',()=>{replyToId=null;replyToText=null;$('reply-preview').style.display='none';});

// ── Bearbeiten ────────────────────────────────────
function startEdit(id,currentText){
  editingId=id;
  $('edit-bar').style.display='block';
  $('msg-input').value=currentText; $('msg-input').focus();
  setTimeout(()=>{if(editingId===id){editingId=null;$('edit-bar').style.display='none';}},EDIT_WINDOW_MS);
}
$('btn-edit-cancel').addEventListener('click',()=>{editingId=null;$('edit-bar').style.display='none';$('msg-input').value='';});

// ── Zurückziehen ──────────────────────────────────
function retractMessage(id){
  if(!ws||ws.readyState!==1)return;
  ws.send(JSON.stringify({type:'retract',id})); applyRetract(id);
}
function applyRetract(id){
  const own=myMsgs.get(id);
  if(own){applyRetractEl(own.el);myMsgs.delete(id);return;}
  const el=$('messages').querySelector(`[data-id="${CSS.escape(id)}"]`);
  if(el)applyRetractEl(el);
}
function applyRetractEl(el){
  el.classList.add('retracted');
  ['msg-body','msg-img','msg-audio','msg-vid','msg-file','msg-quote'].forEach(cls=>el.querySelector('.'+cls)?.remove());
  const ph=document.createElement('div'); ph.className='msg-body'; ph.textContent='[zurückgezogen]';
  el.insertBefore(ph,el.querySelector('.msg-meta'));
  el.querySelector('.msg-meta')?.remove();
}

// ── Status ────────────────────────────────────────
function setStatus(state,text){
  const c=$('status-cursor'); c.className='cursor-blink '+state;
  $('status-text').textContent=text;
}
function enableInput(yes){$('msg-input').disabled=!yes;$('btn-send').disabled=!yes;if(yes)$('msg-input').focus();}

// ── Typing ────────────────────────────────────────
function sendTyping(active){
  if(!ws||ws.readyState!==1)return;
  if(active===typingActive)return;
  typingActive=active; ws.send(JSON.stringify({type:'typing',active}));
}
$('msg-input').addEventListener('input',function(){
  this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,120)+'px';
  sendTyping(true); clearTimeout(typingTimer); typingTimer=setTimeout(()=>sendTyping(false),2000);
});

// ── Schriftgröße ──────────────────────────────────
function applyFontSize(s){
  fontSize=Math.min(22,Math.max(12,s));
  $('messages').style.fontSize=fontSize+'px'; $('msg-input').style.fontSize=fontSize+'px';
  $('font-size-label').textContent=fontSize+'px';
}
$('font-up').addEventListener('click',()=>applyFontSize(fontSize+1));
$('font-down').addEventListener('click',()=>applyFontSize(fontSize-1));

// ── SD Toggle ─────────────────────────────────────
$('btn-sd-toggle').addEventListener('click',()=>{
  sdTextEnabled=!sdTextEnabled;
  $('btn-sd-toggle').classList.toggle('active',sdTextEnabled);
  $('sd-compose-row').style.display=sdTextEnabled?'flex':'none';
});

// ── Verlängern ────────────────────────────────────
$('btn-extend').addEventListener('click',()=>{if(ws?.readyState===1)ws.send(JSON.stringify({type:'extend'}));});

// ── Medien ────────────────────────────────────────
async function handleFileOrImage(file){
  if(!file||!ws||ws.readyState!==1)return;
  const isImage=file.type.startsWith('image/');
  const isVideo=file.type.startsWith('video/');
  if(isImage){
    addSystem('Bild wird komprimiert …');
    try{
      const{dataUrl,mime,size}=await compressImage(file);
      addSystem(`Bild bereit (${Math.round(size/1024)} KB)`);
      pendingMediaData=dataUrl; pendingMediaMime=mime; pendingMediaType='image';
      $('img-preview').src=dataUrl; $('img-preview').style.display='block';
      $('vid-preview').style.display='none';
      $('media-preview-overlay').style.display='flex';
    }catch{addSystem('[Bild konnte nicht verarbeitet werden]');}
  }else if(isVideo){
    if(file.size>MAX_FILE_BYTES*5){addSystem('[Video zu groß — max. 50MB]');return;}
    const reader=new FileReader();
    reader.onload=e=>{
      pendingMediaData=e.target.result; pendingMediaMime=file.type; pendingMediaType='video';
      $('vid-preview').src=e.target.result; $('vid-preview').style.display='block';
      $('img-preview').style.display='none';
      $('media-preview-overlay').style.display='flex';
    };
    reader.readAsDataURL(file);
  }else{
    if(file.size>MAX_FILE_BYTES){addSystem(`[Datei zu groß — max. ${MAX_FILE_BYTES/1024/1024}MB]`);return;}
    const reader=new FileReader();
    reader.onload=async e=>{
      const id=newMsgId();
      try{const payload=await encrypt(e.target.result);ws.send(JSON.stringify({type:'file',id,payload,filename:file.name,filesize:file.size}));addFileMessage(e.target.result,file.name,file.size,'self',id,Date.now(),!partnerConnected);}
      catch{addSystem('[Datei konnte nicht gesendet werden]');}
    };
    reader.readAsDataURL(file);
  }
}

$('btn-attach').addEventListener('click',()=>$('file-input').click());
$('file-input').addEventListener('change',async e=>{for(const f of e.target.files)await handleFileOrImage(f);e.target.value='';});
$('btn-media-cancel').addEventListener('click',()=>{$('media-preview-overlay').style.display='none';pendingMediaData=null;});
$('btn-media-send').addEventListener('click',async()=>{
  if(!pendingMediaData||ws?.readyState!==1)return;
  $('media-preview-overlay').style.display='none';
  const id=newMsgId();
  const sdSeconds=$('sd-check').checked?parseInt($('sd-timer').value):null;
  try{
    const payload=await encrypt(pendingMediaData);
    if(pendingMediaType==='image'){ws.send(JSON.stringify({type:'image',id,payload,mime:pendingMediaMime,sdSeconds}));addImageMessage(pendingMediaData,'self',id,Date.now(),!partnerConnected);if(sdSeconds)scheduleSelfDestruct(id,sdSeconds);}
    else{ws.send(JSON.stringify({type:'video',id,payload,sdSeconds}));addVideoMessage(pendingMediaData,'self',id,Date.now(),!partnerConnected);if(sdSeconds)scheduleSelfDestruct(id,sdSeconds);}
  }catch{addSystem('[Senden fehlgeschlagen]');}
  pendingMediaData=null; pendingMediaMime=null; pendingMediaType=null;
});

// ── Video aufnehmen ───────────────────────────────
$('btn-video-rec').addEventListener('click',async()=>{
  if(videoRecorder?.state==='recording')return;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    $('video-preview-live').srcObject=stream;
    videoChunks=[]; videoRecSeconds=0;
    const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';
    videoRecorder=new MediaRecorder(stream,{mimeType:mime});
    videoRecorder.ondataavailable=e=>{if(e.data.size>0)videoChunks.push(e.data);};
    videoRecorder.onstop=()=>{
      clearInterval(videoRecInterval); stream.getTracks().forEach(t=>t.stop());
      $('video-rec-bar').classList.remove('active'); $('video-preview-live').srcObject=null;
      if(!videoChunks.length)return;
      const blob=new Blob(videoChunks,{type:'video/webm'});
      const reader=new FileReader();
      reader.onload=e=>{
        pendingMediaData=e.target.result; pendingMediaMime='video/webm'; pendingMediaType='video';
        $('vid-preview').src=e.target.result; $('vid-preview').style.display='block';
        $('img-preview').style.display='none';
        $('media-preview-overlay').style.display='flex';
      };
      reader.readAsDataURL(blob);
    };
    videoRecorder.start();
    $('video-rec-bar').classList.add('active'); $('video-rec-time').textContent='0:00';
    videoRecInterval=setInterval(()=>{videoRecSeconds++;const m=Math.floor(videoRecSeconds/60),s=videoRecSeconds%60;$('video-rec-time').textContent=`${m}:${String(s).padStart(2,'0')}`;if(videoRecSeconds>=VIDEO_MAX_SEC)stopVideoRec();},1000);
  }catch{addSystem('[Kein Kamerazugriff]');}
});
function stopVideoRec(){if(videoRecorder?.state==='recording')videoRecorder.stop();}
$('btn-video-cancel').addEventListener('click',()=>{videoChunks=[];if(videoRecorder?.state==='recording'){videoRecorder.onstop=()=>{clearInterval(videoRecInterval);$('video-rec-bar').classList.remove('active');$('video-preview-live').srcObject=null;};videoRecorder.stop();}});
$('btn-video-send').addEventListener('click',stopVideoRec);

// ── Audio aufnehmen ───────────────────────────────
let analyser=null,waveAnim=null;
function drawWaveform(){
  if(!analyser)return;
  const canvas=$('waveform'),ctx=canvas.getContext('2d');
  const buf=new Uint8Array(analyser.frequencyBinCount);
  const draw=()=>{
    waveAnim=requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(buf);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle='#00ff41'; ctx.lineWidth=1.5; ctx.beginPath();
    const sw=canvas.width/buf.length;
    buf.forEach((v,i)=>{const x=i*sw,y=(v/128)*canvas.height/2;i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
    ctx.stroke();
  };draw();
}
$('btn-mic').addEventListener('click',async()=>{
  if(mediaRecorder?.state==='recording')return;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    const src=audioCtx.createMediaStreamSource(stream);
    analyser=audioCtx.createAnalyser(); analyser.fftSize=256; src.connect(analyser);
    audioChunks=[]; recSeconds=0;
    mediaRecorder=new MediaRecorder(stream);
    mediaRecorder.ondataavailable=e=>{if(e.data.size>0)audioChunks.push(e.data);};
    mediaRecorder.onstop=async()=>{
      cancelAnimationFrame(waveAnim); clearInterval(recInterval);
      stream.getTracks().forEach(t=>t.stop()); audioCtx.close();
      $('recording-bar').classList.remove('active');
      if(!audioChunks.length)return;
      const blob=new Blob(audioChunks,{type:'audio/webm'});
      const r=new FileReader();
      r.onload=async e=>{
        const id=newMsgId();
        try{const payload=await encrypt(e.target.result);ws.send(JSON.stringify({type:'audio',id,payload}));addAudioMessage(e.target.result,'self',id,Date.now(),!partnerConnected);}
        catch{addSystem('[Audio konnte nicht gesendet werden]');}
      };
      r.readAsDataURL(blob);
    };
    mediaRecorder.start();
    $('recording-bar').classList.add('active'); $('rec-time').textContent='0:00';
    recInterval=setInterval(()=>{recSeconds++;const m=Math.floor(recSeconds/60),s=recSeconds%60;$('rec-time').textContent=`${m}:${String(s).padStart(2,'0')}`;if(recSeconds>=120)stopRec();},1000);
    drawWaveform();
  }catch{addSystem('[Kein Mikrofonzugriff]');}
});
function stopRec(){if(mediaRecorder?.state==='recording')mediaRecorder.stop();}
$('btn-rec-cancel').addEventListener('click',()=>{audioChunks=[];if(mediaRecorder?.state==='recording'){mediaRecorder.onstop=()=>{cancelAnimationFrame(waveAnim);clearInterval(recInterval);$('recording-bar').classList.remove('active');};mediaRecorder.stop();}});
$('btn-rec-send').addEventListener('click',stopRec);

// ── Text senden ───────────────────────────────────
async function sendMessage(){
  const input=$('msg-input'), text=input.value.trim();
  if(!text||!ws||ws.readyState!==1)return;
  if(editingId){
    const id=editingId; editingId=null; $('edit-bar').style.display='none';
    input.value=''; input.style.height='';
    try{const payload=await encrypt(text);ws.send(JSON.stringify({type:'edit',id,payload}));
      const el=$('messages').querySelector(`[data-id="${CSS.escape(id)}"]`);
      if(el){const t=el.querySelector('.msg-text');if(t)t.textContent=text;
        let ed=el.querySelector('.edited-label');
        if(!ed){ed=document.createElement('span');ed.className='edited-label';ed.textContent='(bearbeitet)';el.querySelector('.msg-meta')?.prepend(ed);}
      }
    }catch{addSystem('[Bearbeitung fehlgeschlagen]');}
    return;
  }
  if(text.length>MAX_TEXT_LEN){addSystem(`[Max. ${MAX_TEXT_LEN} Zeichen]`);return;}
  input.value=''; input.style.height=''; sendTyping(false);
  const id=newMsgId();
  const sdSeconds=sdTextEnabled?parseInt($('sd-text-timer').value):null;
  const qId=replyToId, qText=replyToText;
  replyToId=null; replyToText=null; $('reply-preview').style.display='none';
  try{
    const payload=await encrypt(text);
    ws.send(JSON.stringify({type:'reply',id,payload,quoteId:qId,quoteText:qText?.slice(0,120),sdSeconds}));
    const el=addTextMessage(text,'self',id,Date.now(),!partnerConnected,qId,qText);
    if(sdSeconds)scheduleSelfDestruct(id,sdSeconds);
  }catch{addSystem('[Verschlüsselung fehlgeschlagen]');}
}
$('btn-send').addEventListener('click',sendMessage);
$('msg-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});

// ── Raum erstellen ────────────────────────────────
$('btn-create').addEventListener('click',async()=>{
  $('btn-create').disabled=true; $('btn-create').textContent='[ INITIALISIERUNG … ]';
  try{
    const{key,b64url}=await generateKey(); cryptoKey=key;
    const pwPlain=$('pw-input').value;
    const pwHash=pwPlain?await hashPassword(pwPlain):null;
    const res=await fetch('/api/room',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pwHash})});
    if(!res.ok)throw new Error();
    const data=await res.json(); roomId=data.roomId;
    const link=`${location.origin}/r/${roomId}#${b64url}`;
    $('share-link').textContent=link;
    try{await navigator.clipboard.writeText(link);$('copy-notice').textContent='📋 LINK KOPIERT — Einfach in WhatsApp einfügen!';}
    catch{$('copy-notice').textContent='> Link antippen und kopieren.';}
    $('btn-qr').addEventListener('click',()=>showQR(link));
    $('btn-copy').addEventListener('click',async()=>{
      try{await navigator.clipboard.writeText(link);$('btn-copy').textContent='✓';setTimeout(()=>$('btn-copy').textContent='COPY',2000);}
      catch{getSelection().selectAllChildren($('share-link'));}
    });
    pendingPwHash=null;
    $('link-bar').style.display='block';
    showScreen('chat'); openWebSocket(); startCountdown(Date.now());
  }catch{
    $('btn-create').disabled=false; $('btn-create').textContent='[ SICHEREN CHAT ERSTELLEN ]';
    alert('Raum konnte nicht erstellt werden.');
  }
});

// ── PW Join ───────────────────────────────────────
$('btn-pw-join').addEventListener('click',joinWithPassword);
$('pw-join').addEventListener('keydown',e=>{if(e.key==='Enter')joinWithPassword();});
async function joinWithPassword(){
  const pw=$('pw-join').value;
  if(!pw){$('pw-error').style.display='block';return;}
  pendingPwHash=await hashPassword(pw); $('pw-error').style.display='none';
  showScreen('chat'); openWebSocket();
  try{const r=await fetch(`/api/room/${roomId}`);if(r.ok){const d=await r.json();startCountdown(d.createdAt);}}catch{}
}

// ── Fragment Init ─────────────────────────────────
async function initFromFragment(){
  const match=location.pathname.match(/^\/r\/([a-f0-9]{32})$/);
  if(!match)return false;
  const frag=location.hash.slice(1); if(!frag){showClosed('Ungültiger Link.');return true;}
  roomId=match[1];
  try{cryptoKey=await importKey(frag);}catch{showClosed('Schlüssel ungültig.');return true;}
  history.replaceState(null,'',location.pathname);
  try{
    const res=await fetch(`/api/room/${roomId}`);
    if(!res.ok){showClosed('Raum existiert nicht oder wurde gelöscht.');return true;}
    const data=await res.json();
    if(data.hasPassword){showScreen('pw');return true;}
    showScreen('chat'); openWebSocket(); startCountdown(data.createdAt);
  }catch{showScreen('chat');openWebSocket();}
  return true;
}

// ── WebSocket ─────────────────────────────────────
function openWebSocket(){
  if(ws){try{ws.close();}catch{}ws=null;} stopKeepalive();
  ws=new WebSocket(`${WS_PROTO}//${location.host}/ws/${roomId}`);

  ws.addEventListener('open',()=>{
    reconnectAttempts=0; cancelReconnect();
    setStatus('waiting','WARTE AUF PARTNER …');
    enableInput(true); startKeepalive();
    if(pendingPwHash)ws.send(JSON.stringify({type:'auth',pwHash:pendingPwHash}));
    if($('messages').children.length===0)
      addSystem('Verbunden. Nachrichten werden zugestellt wenn der andere beitritt.');
    else addSystem('Verbindung wiederhergestellt.');
  });

  ws.addEventListener('message',async evt=>{
    let msg; try{msg=JSON.parse(evt.data);}catch{return;}
    switch(msg.type){
      case 'pong':break;
      case 'auth_ok':addSystem('Passwort korrekt ✓');break;
      case 'auth_fail':intentionalClose=true;showClosed('Falsches Passwort.');break;
      case 'room_sealed':$('sealed-banner').classList.add('visible');break;

      case 'participant_count':{
        const was=partnerConnected; partnerConnected=msg.count>=2;
        if(partnerConnected&&!was){
          setStatus('connected','VERBUNDEN · E2E · FORWARD SECRECY');
          setPartnerBanner('online'); addSystem('Partner ist online.');
          for(const[id] of myMsgs)markDelivered(id);
          hasShownNewMsgDivider=false;
        }else if(!partnerConnected&&was){
          setStatus('waiting','PARTNER OFFLINE'); setPartnerBanner('offline');
          addSystem('Partner hat die Verbindung getrennt.'); hasShownNewMsgDivider=false;
        }else if(!partnerConnected)setStatus('waiting','WARTE AUF PARTNER …');
        break;
      }

      case 'chat':case 'reply':{
        if(!partnerConnected)insertNewMsgDivider();
        try{
          const plain=await decrypt(msg.payload);
          addTextMessage(plain,'other',msg.id,msg.ts,false,msg.quoteId,msg.quoteText);
          if(msg.pending)addSystem('Gesendet bevor du beigetreten bist.');
          if(msg.sdSeconds)scheduleSelfDestruct(msg.id,msg.sdSeconds);
          playPing();vibrate();bumpUnread();
        }catch{addSystem('[Entschlüsselung fehlgeschlagen]');}
        $('typing-indicator').style.display='none'; break;
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
          const tl=document.createElement('span');tl.className='read-time';tl.textContent=` ${msg.readAt}`;
          e.readEl.after(tl);
        }break;
      }
      case 'typing':$('typing-indicator').style.display=msg.active?'flex':'none';break;
      case 'retract':applyRetract(msg.id);break;
      case 'self_destruct_ack':scheduleSelfDestruct(msg.id,0);break;

      case 'edit':{
        try{
          const plain=await decrypt(msg.payload);
          const el=$('messages').querySelector(`[data-id="${CSS.escape(msg.id)}"]`);
          if(el){const t=el.querySelector('.msg-text');if(t)t.textContent=plain;
            let ed=el.querySelector('.edited-label');
            if(!ed){ed=document.createElement('span');ed.className='edited-label';ed.textContent='(bearbeitet)';el.querySelector('.msg-meta')?.prepend(ed);}
          }
        }catch{}break;
      }
      case 'extended':{roomExpiry=msg.newExpiry;addSystem(`Raum verlängert. Noch ${msg.extensionsLeft}× möglich.`);break;}
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
    if(evt.code===4001){showClosed('Raum wurde gelöscht.');return;}
    if(evt.code===4002){showClosed('Raum ist voll.');return;}
    if(evt.code===4003){showClosed('Authentifizierung fehlgeschlagen.');return;}
    setStatus('disconnected','VERBINDUNG GETRENNT'); scheduleReconnect();
  });
  ws.addEventListener('error',()=>setStatus('disconnected','VERBINDUNGSFEHLER'));
}

// ── Beenden ───────────────────────────────────────
$('btn-end').addEventListener('click',()=>{
  if(!confirm('Chat wirklich beenden?'))return;
  intentionalClose=true; cancelReconnect();
  if(ws?.readyState===1)ws.send(JSON.stringify({type:'end'}));
  showClosed('Du hast den Chat beendet. Alle Nachrichten gelöscht.');
});

// ── Neuer Chat ────────────────────────────────────
$('btn-new').addEventListener('click',()=>{
  intentionalClose=true; cancelReconnect(); stopKeepalive();
  for(const t of sdTimers.values())clearInterval(t); sdTimers.clear();
  cryptoKey=null;roomId=null;ws=null;subKey=null;forwardSecretCounter=0;
  partnerConnected=typingActive=sdTextEnabled=false;
  pendingPwHash=null;reconnectAttempts=0;intentionalClose=false;
  clearInterval(countdownInterval);
  $('messages').innerHTML=''; myMsgs.clear();
  $('typing-indicator').style.display='none';
  $('countdown-wrap').style.display='none';
  $('link-bar').style.display='none';
  $('sd-compose-row').style.display='none';
  $('btn-sd-toggle').classList.remove('active');
  $('reply-preview').style.display='none';
  $('edit-bar').style.display='none';
  $('recording-bar').classList.remove('active');
  $('video-rec-bar').classList.remove('active');
  $('reconnect-banner').className='';
  $('sealed-banner').classList.remove('visible');
  $('pw-input').value=''; $('pw-strength-fill').style.width='0';
  enableInput(false);
  const b=$('partner-banner'); if(b)b.style.display='none';
  history.replaceState(null,'','/');
  showScreen('home');
  $('btn-create').disabled=false; $('btn-create').textContent='[ SICHEREN CHAT ERSTELLEN ]';
});

function showClosed(reason){
  intentionalClose=true; cancelReconnect(); stopKeepalive(); clearInterval(countdownInterval);
  for(const t of sdTimers.values())clearInterval(t);
  if(ws?.readyState===1)try{ws.close();}catch{}
  ws=null; $('closed-reason').textContent=reason||'Raum gelöscht.'; showScreen('closed');
}
function closedReason(code){
  return{user_ended:'Der Gesprächspartner hat den Chat beendet.',inactivity:'Raum nach 2 Stunden geschlossen.',all_left:'Alle Teilnehmer haben den Raum verlassen.'}[code]||'Raum geschlossen.';
}

// ── Start ─────────────────────────────────────────
(async()=>{const h=await initFromFragment();if(!h)showScreen('home');})();
