(() => {
"use strict";

/*
  SPRITE LAYOUT — animals (8 columns × 5 rows)
  row 0: down c0-3, up c4-7
  row 1: left c0-3, right c4-7
  row 2: down+bomb c0-3, up+bomb c4-7
  row 3: left+bomb c0-3, right+bomb c4-7
  row 4: death c0-5

  BOMB LAYOUT
  row 0: fuse / swelling c0-7
  row 1: pushed left c0-3, pushed right c4-7
  row 2: pushed up c0-3, pushed down c4-7
  row 3: explosion c0-7
  row 4: powered fuse c0-7
*/

const TILE = 64;
const COLS = 13, ROWS = 11;
const SHEET_COLS = 8, SHEET_ROWS = 5;
const SRC_PAD_FRAC = 1/96; // crop this fraction of a cell off each edge when reading sprite frames, as a small safety margin (the sheets themselves are pre-cleaned of background/border artifacts)
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha:false });
ctx.imageSmoothingEnabled = false;

const ASSETS = {};
const ASSET_CELL = {}; // per-asset {w,h} cell size, since sheets aren't all the same resolution
const assetNames = ["dog","cat","bird","croc","bomb"];

// source rect [sx,sy,sw,sh] for frame `col`,`row` of sprite `name`, inset to avoid neighbor bleed
function srcRect(name,col,row){
  const c=ASSET_CELL[name];
  const px=c.w*SRC_PAD_FRAC, py=c.h*SRC_PAD_FRAC;
  return [col*c.w+px, row*c.h+py, c.w-px*2, c.h-py*2];
}

// All species start with identical stats (1 bomb, blast 1, no special ability).
// Each one only gets its unique trait once it picks up a "power" powerup.
const SPECIES = {
  dog: {
    name:"Cão", speed:185, blast:1, lives:3, bombCap:1,
    bonus:"Faro apurado: ao pegar o powerup de poder, resgata a própria bomba de volta para a mão.",
    color:"#9c6330", power:"recall"
  },
  cat: {
    name:"Gato", speed:185, blast:1, lives:3, bombCap:1,
    bonus:"Pernas de mola: ao pegar o powerup de poder, pula por cima de caixotes.",
    color:"#e98d27", power:"jump"
  },
  bird: {
    name:"Calopsita", speed:185, blast:1, lives:3, bombCap:1,
    bonus:"Asas fantasma: ao pegar o powerup de poder, atravessa bombas.",
    color:"#f0c83a", power:"ghost"
  },
  croc: {
    name:"Jacaré", speed:185, blast:1, lives:3, bombCap:1,
    bonus:"Mandíbula forte: ao pegar o powerup de poder, quebra caixotes com um golpe.",
    color:"#4f7942", power:"break"
  }
};

// Everything is now a server room: "local" play is just a room nobody else joined, where the
// other 3 of the 4 species slots auto-fill with bots (server_sim.js's native behavior). This
// client only ever renders state broadcast by the server and sends input/actions — there's no
// client-side simulation anymore.
const state = {
  running:false,
  playing:false, // true once inside an active match (vs. still picking a species in the room)
  players:[],
  bombs:[],
  blasts:[],
  blocks:new Set(),
  powerups:[],
  keys:new Set(),
  myIndex:0
};
function myPlayer(){ return state.players[state.myIndex]; }

function isFixedWall(x,y){
  return x<0||y<0||x>=COLS||y>=ROWS||x===0||y===0||x===COLS-1||y===ROWS-1||(x%2===0&&y%2===0);
}

function loadImage(src){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>resolve(img);
    img.onerror=reject;
    img.src=src;
  });
}

async function boot(){
  await Promise.all(assetNames.map(async n => ASSETS[n] = await loadImage(`assets/${n}.png`)));
  for(const n of assetNames){
    const img=ASSETS[n];
    ASSET_CELL[n]={w:img.width/SHEET_COLS, h:img.height/SHEET_ROWS};
  }
  wireUI();
  await initAuthFlow();
}

// ---- auth: login/cadastro gate before anything else. A valid session cookie skips straight
// to the lobby; otherwise the auth form is the first thing anyone sees. ----
async function initAuthFlow(){
  try{
    const res=await fetch("/api/me");
    const data=await res.json();
    if(data.ok && data.user){ enterLobby(data.user.username); return; }
  }catch(e){ /* server not reachable — fall through to the login form */ }
  document.getElementById("authScreen").classList.remove("hidden");
}

function enterLobby(username){
  document.getElementById("authScreen").classList.add("hidden");
  document.getElementById("roomScreen").classList.add("hidden");
  document.getElementById("gameScreen").classList.add("hidden");
  document.getElementById("lobbyScreen").classList.remove("hidden");
  document.getElementById("lobbyUsername").textContent=username;
  ensureOnlineSocket();
  wsSend({type:"watchLobby"});
  // A shared link (?room=CODE) joins that room automatically once logged in.
  const roomParam=new URLSearchParams(location.search).get("room");
  if(roomParam) wsSend({type:"joinRoom",code:roomParam.toUpperCase()});
}

// Steps back from gameplay to the room's species-picker screen without leaving the room
// (used after a round ends with no human left alive — see the round-end choice buttons) —
// the WS connection and picked species stay put, so hitting "Iniciar sala" again jumps
// straight back in as the same species.
function returnToRoomScreen(){
  state.running=false;
  state.playing=false;
  state.keys.clear();
  onlineStarted=false;
  hideMessage();
  document.getElementById("gameScreen").classList.add("hidden");
  document.getElementById("roomScreen").classList.remove("hidden");
}

function returnToLobby(){
  state.running=false;
  state.playing=false;
  state.keys.clear();
  if(ws){ ws.close(); ws=null; }
  onlineRoomCode=null; onlineStarted=false; onlinePickedSpecies=null;
  document.getElementById("roomScreen").classList.add("hidden");
  document.getElementById("gameScreen").classList.add("hidden");
  document.getElementById("lobbyScreen").classList.remove("hidden");
  setOnlineStatus("");
  ensureOnlineSocket();
  wsSend({type:"watchLobby"});
}

// Space/bomb-button action: always forwarded to the server, which runs the real simulation.
function triggerAction(){
  if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:"action"}));
}

function wireUI(){
  let authMode="login";
  const authLead=document.getElementById("authLead");
  const authError=document.getElementById("authError");
  const authSubmitBtn=document.getElementById("authSubmitBtn");
  const authToggleLink=document.getElementById("authToggleLink");
  function setAuthMode(mode){
    authMode=mode;
    authLead.textContent = mode==="login" ? "Entre com sua conta pra jogar." : "Crie uma conta pra jogar.";
    authSubmitBtn.textContent = mode==="login" ? "Entrar" : "Cadastrar";
    authToggleLink.textContent = mode==="login" ? "Cadastre-se" : "Entrar";
    authError.classList.add("hidden");
  }
  authToggleLink.onclick=()=>setAuthMode(authMode==="login"?"register":"login");

  document.getElementById("authForm").addEventListener("submit",async(e)=>{
    e.preventDefault();
    const username=document.getElementById("authUsername").value.trim();
    const password=document.getElementById("authPassword").value;
    authError.classList.add("hidden");
    try{
      const res=await fetch(authMode==="login"?"/api/login":"/api/register",{
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({username,password})
      });
      const data=await res.json();
      if(!data.ok){
        const reasons={
          "invalid-credentials":"Usuário ou senha incorretos.",
          "username-taken":"Esse usuário já existe.",
          "invalid-username":"Usuário deve ter 3-20 letras/números/underline.",
          "invalid-password":"Senha deve ter pelo menos 6 caracteres."
        };
        authError.textContent=reasons[data.error]||"Não foi possível entrar.";
        authError.classList.remove("hidden");
        return;
      }
      enterLobby(data.username);
    }catch(e){
      authError.textContent="Não foi possível conectar ao servidor.";
      authError.classList.remove("hidden");
    }
  });

  document.getElementById("logoutLink").onclick=async()=>{
    try{ await fetch("/api/logout",{method:"POST"}); }catch(e){}
    if(ws){ ws.close(); ws=null; }
    state.running=false;
    state.playing=false;
    document.getElementById("lobbyScreen").classList.add("hidden");
    document.getElementById("roomScreen").classList.add("hidden");
    document.getElementById("gameScreen").classList.add("hidden");
    document.getElementById("authUsername").value="";
    document.getElementById("authPassword").value="";
    setAuthMode("login");
    document.getElementById("authScreen").classList.remove("hidden");
  };

  document.getElementById("createRoomBtn").onclick=createOnlineRoom;
  document.getElementById("joinRoomBtn").onclick=joinOnlineRoom;
  document.getElementById("startRoomBtn").onclick=()=>wsSend({type:"startRoom"});
  document.getElementById("copyRoomLinkBtn").onclick=copyRoomLink;
  document.getElementById("leaveRoomBtn").onclick=returnToLobby;
  document.getElementById("backBtn").onclick=returnToLobby;
  document.getElementById("playAgainBtn").onclick=()=>wsSend({type:"restartRound"});
  document.getElementById("backToRoomBtn").onclick=returnToRoomScreen;

  document.getElementById("roomList").addEventListener("click",(e)=>{
    const btn=e.target.closest("[data-join]");
    if(!btn)return;
    ensureOnlineSocket();
    wsSend({type:"joinRoom",code:btn.dataset.join});
  });

  addEventListener("keydown",e=>{
    // Text fields (login, room code, …) need every key — don't hijack WASD/space/arrows
    // away from whatever the user is actually typing into.
    const active=document.activeElement;
    if(active && (active.tagName==="INPUT"||active.tagName==="TEXTAREA")) return;
    const k=e.key.toLowerCase();
    if(["arrowup","arrowdown","arrowleft","arrowright"," ","w","a","s","d"].includes(k)) e.preventDefault();
    state.keys.add(k);
    if(k===" " && state.running) triggerAction();
  },{passive:false});
  addEventListener("keyup",e=>state.keys.delete(e.key.toLowerCase()));

  document.querySelectorAll("[data-dir]").forEach(btn=>{
    const dir=btn.dataset.dir;
    const key={up:"arrowup",down:"arrowdown",left:"arrowleft",right:"arrowright"}[dir];
    const on=e=>{e.preventDefault();state.keys.add(key)};
    const off=e=>{e.preventDefault();state.keys.delete(key)};
    btn.addEventListener("pointerdown",on);
    btn.addEventListener("pointerup",off);
    btn.addEventListener("pointercancel",off);
    btn.addEventListener("pointerleave",off);
  });
  document.getElementById("bombBtn").addEventListener("pointerdown",e=>{
    e.preventDefault();
    if(state.running) triggerAction();
  });
}

// ---- online multiplayer: connect to the server (server.js + server_sim.js), which runs the
// authoritative simulation for every room — this client only sends input and renders whatever
// state snapshots it receives. Flow: lobby (create/join/pick from a live room list) → room
// (pick a species, live-marked with who's already picked what) → "Iniciar sala" transitions
// every connected client in that room into the gameplay canvas together. A room nobody else
// joins is just you plus 3 bots in the other species slots — same server-side rules either way. ----
let ws=null, lastInputSent=null, onlineRoomCode=null, onlineStarted=false, onlinePickedSpecies=null;
function setOnlineStatus(text,isError){
  const el=document.getElementById("onlineStatus");
  el.textContent=text||"";
  el.classList.toggle("hidden",!text);
  el.classList.toggle("error",!!isError);
}
function ensureOnlineSocket(){
  if(ws && (ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING)) return;
  setOnlineStatus("Conectando…");
  const proto=location.protocol==="https:"?"wss://":"ws://";
  try{ ws=new WebSocket(proto+location.host); }
  catch(e){ setOnlineStatus("Não foi possível conectar. Rode 'node server.js' e tente de novo.",true); return; }
  ws.onopen=()=>setOnlineStatus("");
  ws.onerror=()=>setOnlineStatus("Não foi possível conectar ao servidor. Rode 'node server.js' e tente de novo.",true);
  ws.onclose=()=>{ if(state.playing){state.running=false;setOnlineStatus("Conexão perdida.",true)} };
  ws.onmessage=onOnlineMessage;
}
function wsSend(msg){
  const send=()=>ws.send(JSON.stringify(msg));
  if(ws.readyState===WebSocket.OPEN) send();
  else ws.addEventListener("open",send,{once:true});
}
function createOnlineRoom(){
  ensureOnlineSocket();
  wsSend({type:"createRoom"});
}
function joinOnlineRoom(){
  const code=document.getElementById("joinCodeInput").value.trim();
  if(!code)return;
  ensureOnlineSocket();
  wsSend({type:"joinRoom",code});
}
function pickOnlineSpecies(species){
  wsSend({type:"pickSpecies",species});
}
function copyRoomLink(){
  const url=`${location.origin}${location.pathname}?room=${onlineRoomCode}`;
  navigator.clipboard?.writeText(url).then(
    ()=>setOnlineStatus("Link copiado!"),
    ()=>setOnlineStatus(url)
  );
}

function renderRoomList(rooms){
  const root=document.getElementById("roomList");
  if(!rooms.length){
    root.innerHTML=`<div class="room-list-empty">Nenhuma sala aberta — crie uma!</div>`;
    return;
  }
  root.innerHTML=rooms.map(r=>`
    <div class="room-row">
      <span class="room-row-code">${r.code}</span>
      <span class="room-row-meta">${r.host?`por ${r.host} • `:""}${r.players}/${r.max} vaga${r.players===1?"":"s"} ocupada${r.players===1?"":"s"}</span>
      <span class="badge${r.started?" started":""}">${r.started?"em andamento":"aguardando"}</span>
      <button data-join="${r.code}"${r.players>=r.max?" disabled":""}>Entrar</button>
    </div>
  `).join("");
}

// Built once per room (character art doesn't change) — wired to pickOnlineSpecies, with a
// "taken" badge overlay updated live from state broadcasts without redrawing the sprite.
function buildOnlineSpeciesPicker(){
  const root=document.getElementById("onlineSpeciesPicker");
  root.innerHTML="";
  for(const [id,s] of Object.entries(SPECIES)){
    const el=document.createElement("article");
    el.className="card";
    el.dataset.id=id;
    el.innerHTML=`
      <canvas width="230" height="176"></canvas>
      <h2>${s.name}</h2>
      <div class="bonus">${s.bonus}</div>
      <div class="taken-badge hidden"></div>`;
    root.appendChild(el);
    const c=el.querySelector("canvas"), cctx=c.getContext("2d");
    cctx.imageSmoothingEnabled=false;
    cctx.drawImage(ASSETS[id],...srcRect(id,0,0),58,28,115,115);
    el.addEventListener("click",()=>{ if(!el.classList.contains("taken")) pickOnlineSpecies(id); });
  }
}
function updateOnlineSpeciesPicker(players){
  for(const p of players){
    const el=document.querySelector(`#onlineSpeciesPicker .card[data-id="${p.species}"]`);
    if(!el)continue;
    const taken=!p.bot;
    el.classList.toggle("taken",taken);
    const badge=el.querySelector(".taken-badge");
    badge.textContent=taken?`✋ ${p.nickname||"ocupado"}`:"";
    badge.classList.toggle("hidden",!taken);
  }
}
function enterOnlineGameplay(){
  state.playing=true;
  document.getElementById("roomScreen").classList.add("hidden");
  document.getElementById("gameScreen").classList.remove("hidden");
  hideMessage();
  setOnlineStatus("");
  state.running=true;
  lastInputSent=null;
  requestAnimationFrame(onlineLoop);
}
function onOnlineMessage(ev){
  const msg=JSON.parse(ev.data);
  if(msg.type==="roomJoined"){
    onlineRoomCode=msg.code;
    onlineStarted=false;
    onlinePickedSpecies=null;
    document.getElementById("roomCodeDisplay").textContent=msg.code;
    document.getElementById("lobbyScreen").classList.add("hidden");
    document.getElementById("roomScreen").classList.remove("hidden");
    document.getElementById("roomStartedNote").classList.add("hidden");
    buildOnlineSpeciesPicker();
  }else if(msg.type==="joined"){
    // Claims the slot. If the room's already running (a late join), jump straight in;
    // otherwise wait in the room screen with everyone else until someone hits "Iniciar sala".
    state.myIndex=msg.index;
    onlinePickedSpecies=msg.species;
    if(onlineStarted) enterOnlineGameplay();
  }else if(msg.type==="error"){
    const reasons={"species-taken":"Essa espécie já está em uso, escolha outra.","room-not-found":"Sala não encontrada — confira o código.","no-room":"Entre numa sala primeiro."};
    setOnlineStatus(reasons[msg.reason]||"Erro.",true);
  }else if(msg.type==="roomList"){
    renderRoomList(msg.rooms);
  }else if(msg.type==="state"){
    if(msg.code!==onlineRoomCode)return;
    if(!state.playing){
      // Still picking a species (haven't transitioned to gameplay yet): keep the picker live
      // and watch for the room actually starting.
      updateOnlineSpeciesPicker(msg.players);
      document.getElementById("roomStartedNote").classList.toggle("hidden",!msg.started);
      if(msg.started && !onlineStarted){
        onlineStarted=true;
        if(onlinePickedSpecies) enterOnlineGameplay();
        // else: keep waiting — they can still pick to join the live match
      }
    }
    if(state.playing){
      state.players=msg.players;
      state.bombs=msg.bombs;
      state.blasts=msg.blasts;
      state.powerups=msg.powerups;
      state.blocks=new Set(msg.blocks);
      if(msg.message){ if(msg.awaitingRestart) showRoundEndChoice(msg.message); else showMessage(msg.message); }
      else hideMessage();
      updateHud();
    }
  }
}
function inputVector(){
  let x=0,y=0;
  if(state.keys.has("arrowleft")||state.keys.has("a"))x--;
  if(state.keys.has("arrowright")||state.keys.has("d"))x++;
  if(state.keys.has("arrowup")||state.keys.has("w"))y--;
  if(state.keys.has("arrowdown")||state.keys.has("s"))y++;
  if(x&&y){const q=Math.SQRT1_2;x*=q;y*=q}
  return {x,y};
}
function onlineLoop(now){
  if(!state.playing||!state.running)return;
  const v=inputVector();
  const key=v.x+","+v.y;
  if(key!==lastInputSent && ws && ws.readyState===WebSocket.OPEN){
    lastInputSent=key;
    ws.send(JSON.stringify({type:"input",x:v.x,y:v.y}));
  }
  draw(now/1000);
  requestAnimationFrame(onlineLoop);
}

function showMessage(t){
  document.getElementById("messageText").textContent=t;
  document.getElementById("message").classList.remove("hidden");
  document.getElementById("roundEndChoice").classList.add("hidden");
}
// Shown instead of the plain message when the round ended because no human is left alive —
// lets whoever's still there choose to jump into a fresh round or step back to the room
// screen, instead of the game silently auto-restarting with nobody watching.
function showRoundEndChoice(t){
  document.getElementById("messageText").textContent=t;
  document.getElementById("message").classList.remove("hidden");
  document.getElementById("roundEndChoice").classList.remove("hidden");
}
function hideMessage(){
  document.getElementById("message").classList.add("hidden");
  document.getElementById("roundEndChoice").classList.add("hidden");
}

function updateHud(){
  const p=myPlayer();if(!p)return;
  const hasPower=p.canJumpCrates||p.canBreakCrates||p.canRecallBomb||p.ghostBombs;
  document.getElementById("playerBadge").textContent=SPECIES[p.species].name+(p.kickCharges>0?` • 👢${p.kickCharges}`:"")+(hasPower?" • 🌟":"")+(p.superBombs?` • ✨${p.superBombs}`:"");
  document.getElementById("hudLives").textContent=Math.max(0,p.lives);
  document.getElementById("hudRange").textContent=p.blast;
  document.getElementById("hudBombs").textContent=`${p.bombCap-p.activeBombs}/${p.bombCap}`;
  document.getElementById("hudSpeed").textContent=(p.speed/172).toFixed(1)+"×";
}

function draw(t){
  // floor
  ctx.fillStyle="#17251f";ctx.fillRect(0,0,canvas.width,canvas.height);
  for(let y=0;y<ROWS;y++){
    for(let x=0;x<COLS;x++){
      ctx.fillStyle=((x+y)&1)?"#2a493b":"#315241";
      ctx.fillRect(x*TILE,y*TILE,TILE,TILE);
      ctx.fillStyle="rgba(255,255,255,.025)";ctx.fillRect(x*TILE,y*TILE,TILE,1);
    }
  }

  // fixed stone walls
  for(let y=0;y<ROWS;y++)for(let x=0;x<COLS;x++)if(isFixedWall(x,y))drawWall(x,y);

  // crates
  for(const k of state.blocks){
    const [x,y]=k.split(",").map(Number);drawCrate(x,y);
  }

  // powerups
  for(const u of state.powerups)drawPowerup(u,t);

  // bombs under players
  for(const b of state.bombs)drawBomb(b,t);

  // players
  const sorted=[...state.players].sort((a,b)=>a.y-b.y);
  for(const p of sorted)drawPlayer(p,t);

  // explosions on top
  for(const e of state.blasts)drawBlast(e,t);
}

function drawWall(x,y){
  const px=x*TILE,py=y*TILE;
  ctx.fillStyle="#60756c";ctx.fillRect(px+2,py+2,TILE-4,TILE-4);
  ctx.fillStyle="#7d9188";ctx.fillRect(px+6,py+6,TILE-12,12);
  ctx.fillStyle="#43564e";ctx.fillRect(px+6,py+18,TILE-12,TILE-24);
  ctx.strokeStyle="rgba(0,0,0,.28)";ctx.lineWidth=3;ctx.strokeRect(px+3,py+3,TILE-6,TILE-6);
}
function drawCrate(x,y){
  const px=x*TILE,py=y*TILE;
  ctx.fillStyle="#8b572a";ctx.fillRect(px+5,py+5,TILE-10,TILE-10);
  ctx.fillStyle="#b67b3d";ctx.fillRect(px+10,py+10,TILE-20,TILE-20);
  ctx.strokeStyle="#5d371b";ctx.lineWidth=5;
  ctx.beginPath();ctx.moveTo(px+10,py+10);ctx.lineTo(px+TILE-10,py+TILE-10);ctx.moveTo(px+TILE-10,py+10);ctx.lineTo(px+10,py+TILE-10);ctx.stroke();
}
function drawPowerup(u,t){
  const cx=(u.gx+.5)*TILE,cy=(u.gy+.5)*TILE;
  const pulse=1+Math.sin(t*5+u.pulse)*.08;
  const icon={range:"💥",speed:"⚡",bomb:"🎒",kick:"👢",super:"✨",power:"🌟"}[u.kind];
  ctx.save();ctx.translate(cx,cy);ctx.scale(pulse,pulse);
  ctx.fillStyle="#e9efe9";ctx.beginPath();ctx.arc(0,0,20,0,Math.PI*2);ctx.fill();
  ctx.font="25px sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(icon,0,1);ctx.restore();
}

const DEATH_ANIM_DURATION=.9;
function drawPlayer(p,t){
  const img=ASSETS[p.species];
  let row,start,count,frame;
  if(!p.alive){
    if(p.deathTime<=0)return; // finished playing once — vanish instead of looping the explosion forever
    row=4;start=0;count=6;
    const progress=1-p.deathTime/DEATH_ANIM_DURATION;
    frame=start+Math.min(count-1,Math.floor(progress*count));
  }else{
    row=0;start=0;count=4;
    const carry=p.plantAnim>0;
    if(p.dir==="down"){row=carry?2:0;start=0}
    if(p.dir==="up"){row=carry?2:0;start=4}
    if(p.dir==="left"){row=carry?3:1;start=0}
    if(p.dir==="right"){row=carry?3:1;start=4}
    const speed=p.moving?8:2;
    frame=start+(Math.floor(t*speed+p.index*.7)%count);
    if(p.invuln>0 && Math.floor(t*12)%2===0)return;
  }
  const dw=74,dh=74;
  ctx.drawImage(img,...srcRect(p.species,frame,row),p.x-dw/2,p.y-dh*.62,dw,dh);
}

function drawBomb(b,t){
  const img=ASSETS.bomb;
  let row=b.powered?4:0,start=0,count=8;
  if(b.moving){
    count=4;
    if(b.dir==="left"){row=1;start=0}
    if(b.dir==="right"){row=1;start=4}
    if(b.dir==="up"){row=2;start=0}
    if(b.dir==="down"){row=2;start=4}
  }
  let frame;
  if(b.moving)frame=start+(Math.floor(t*12)%count);
  else frame=start+Math.min(count-1,Math.floor((b.age/b.fuse)*count));
  const size=58+(b.powered?4:0);
  ctx.drawImage(img,...srcRect("bomb",frame,row),b.x-size/2,b.y-size*.62,size,size);
  if(b.powered){
    ctx.save();ctx.globalAlpha=.45+.25*Math.sin(t*10);ctx.strokeStyle="#67ff59";ctx.lineWidth=3;
    ctx.beginPath();ctx.arc(b.x,b.y-5,29+Math.sin(t*8)*3,0,Math.PI*2);ctx.stroke();ctx.restore();
  }
}

function drawBlast(e,t){
  const img=ASSETS.bomb;
  const progress=1-e.life/e.max;
  const frame=Math.min(7,Math.floor(progress*8));
  const size=e.powered?88:76;
  ctx.drawImage(img,...srcRect("bomb",frame,3),(e.gx+.5)*TILE-size/2,(e.gy+.5)*TILE-size/2,size,size);
  if(e.powered){
    ctx.save();ctx.globalCompositeOperation="lighter";ctx.globalAlpha=.22;
    ctx.fillStyle="#65ff55";ctx.beginPath();ctx.arc((e.gx+.5)*TILE,(e.gy+.5)*TILE,32,0,Math.PI*2);ctx.fill();ctx.restore();
  }
}

boot().catch(err=>{
  console.error(err);
  document.body.innerHTML=`<pre style="color:white;padding:20px">Falha ao carregar assets: ${err}</pre>`;
});
})();
