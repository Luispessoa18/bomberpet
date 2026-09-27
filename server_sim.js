// Server-side game simulation for online multiplayer. This is a Node port of the same
// rules implemented client-side in game.js (movement, bombs, AI, powerups) — kept as a
// separate file on purpose so the offline single-player mode in game.js is never touched
// by multiplayer work. The server is authoritative: it runs this simulation and broadcasts
// the resulting state to every connected client, which just renders it.
"use strict";

const TILE = 64;
const COLS = 13, ROWS = 11;

const SPECIES = {
  dog: {
    name:"Cão", speed:185, blast:1, lives:3, bombCap:1,
    power:"recall"
  },
  cat: {
    name:"Gato", speed:185, blast:1, lives:3, bombCap:1,
    power:"jump"
  },
  bird: {
    name:"Calopsita", speed:185, blast:1, lives:3, bombCap:1,
    power:"ghost"
  },
  croc: {
    name:"Jacaré", speed:185, blast:1, lives:3, bombCap:1,
    power:"break"
  }
};
const SPECIES_ORDER = ["dog","cat","bird","croc"];
const SPAWNS = [[1,1],[COLS-2,ROWS-2],[COLS-2,1],[1,ROWS-2]];
const AI_DIRS=[{x:1,y:0,d:"right"},{x:-1,y:0,d:"left"},{x:0,y:1,d:"down"},{x:0,y:-1,d:"up"}];

// Score rules used only to pick a fair round winner (highest score, not just last survivor)
// — see the round-end block in tick(). Not tied to any learning/training system.
const POINTS={crate:6, crateWithPowerup:12, powerup:35, death:-20, ownBombDeath:-180, kill:170, kick:5, timeoutDraw:-100, idle:-8, hollowWin:-150};
// How long a player can go without placing a bomb before the idle penalty starts landing
// (and keeps landing every IDLE_BOMB_TIMEOUT seconds while they keep stalling).
const IDLE_BOMB_TIMEOUT=6;
function awardPoints(p,amount){
  p.stats.points+=amount;
}

function tileKey(x,y){return `${x},${y}`}
function isFixedWall(x,y){
  return x<0||y<0||x>=COLS||y>=ROWS||x===0||y===0||x===COLS-1||y===ROWS-1||(x%2===0&&y%2===0);
}
function generateBlocks(room){
  const protectedTiles=new Set();
  SPAWNS.forEach(([x,y])=>{
    [[x,y],[x+1,y],[x-1,y],[x,y+1],[x,y-1]].forEach(([a,b])=>protectedTiles.add(tileKey(a,b)));
  });
  for(let y=1;y<ROWS-1;y++){
    for(let x=1;x<COLS-1;x++){
      if(isFixedWall(x,y)||protectedTiles.has(tileKey(x,y))) continue;
      if(Math.random()<.42) room.blocks.add(tileKey(x,y));
    }
  }
}

function createPlayer(species,gx,gy,index){
  const s=SPECIES[species];
  return {
    species,index,bot:true,socket:null,input:{x:0,y:0},nickname:null,
    x:(gx+.5)*TILE,y:(gy+.5)*TILE,spawn:[gx,gy],
    dir:"down", moving:false,
    speed:s.speed, blast:s.blast, lives:s.lives, bombCap:s.bombCap,
    kickCharges:0, ghostBombs:false, canJumpCrates:false, canBreakCrates:false, canRecallBomb:false,
    alive:true, invuln:0, plantAnim:0, deathTime:0,
    activeBombs:0, superBombs:0, aliveTime:0, idleTimer:0, stats:{kills:0,crates:0,powerups:0,suicides:0,bombsPlaced:0,points:0},
    ai:{tx:gx,ty:gy,think:0}
  };
}

function createRoom(){
  const room={
    running:true, message:null,
    players:[], bombs:[], blasts:[], powerups:[], blocks:new Set()
  };
  initRound(room);
  return room;
}

const ROUND_TIMEOUT=100; // seconds — bounds how long a round can drag on

function initRound(room){
  const previous=room.players; // carry over who's human-controlled, if this isn't the first round
  room.bombs=[]; room.blasts=[]; room.powerups=[];
  room.blocks=new Set();
  room.message=null;
  room.awaitingRestart=false;
  room.roundElapsed=0;
  generateBlocks(room);
  room.players=SPECIES_ORDER.map((id,i)=>{
    const p=createPlayer(id,SPAWNS[i][0],SPAWNS[i][1],i);
    // A fresh round always creates brand-new player objects — without this, whoever was
    // playing a species would silently lose control of it (replaced by a bot) every time a
    // round restarts, since createPlayer() defaults every slot to bot-controlled.
    const prev=previous && previous.find(pl=>pl.species===id);
    if(prev && prev.socket){ p.socket=prev.socket; p.nickname=prev.nickname; p.bot=false; }
    return p;
  });
  room.running=true;
}

function playerOverlapsTile(p,gx,gy){
  const radius=18;
  const left=Math.floor((p.x-radius)/TILE), right=Math.floor((p.x+radius)/TILE);
  const top=Math.floor((p.y-radius)/TILE), bottom=Math.floor((p.y+radius)/TILE);
  return gx>=left && gx<=right && gy>=top && gy<=bottom;
}
function findBombAt(room,gx,gy,exclude){return room.bombs.find(b=>b.gx===gx&&b.gy===gy&&!b.dead&&b!==exclude)}
function canStandAt(room,p,gx,gy){return !isSolidForPlayer(room,p,gx,gy)}
function isSolidForPlayer(room,p,gx,gy){
  if(isFixedWall(gx,gy))return true;
  if(room.blocks.has(tileKey(gx,gy)) && !p.canJumpCrates)return true;
  const bomb=findBombAt(room,gx,gy);
  if(!bomb||p.ghostBombs)return false;
  return !bomb.exempt.has(p);
}

function tryPlaceBomb(room,p){
  if(!p.alive||p.activeBombs>=p.bombCap)return;
  const gx=Math.floor(p.x/TILE),gy=Math.floor(p.y/TILE);
  if(findBombAt(room,gx,gy))return;
  const powered=p.superBombs>0;
  if(powered)p.superBombs--;
  const exempt=new Set(room.players.filter(pl=>playerOverlapsTile(pl,gx,gy)));
  room.bombs.push({
    gx,gy,x:(gx+.5)*TILE,y:(gy+.5)*TILE,owner:p,
    age:0,fuse:2.25,dead:false,powered,exempt,wasKicked:false,
    moving:false,dir:null,speed:330,slideFrame:0
  });
  p.activeBombs++;
  p.plantAnim=.3;
  p.stats.bombsPlaced++;
  p.idleTimer=0;
}
function startBombSlide(b,dir,kicker){
  b.moving=true;b.dir=dir;b.slideFrame=0;b.wasKicked=true;
  if(kicker)awardPoints(kicker,POINTS.kick);
}

function handleAction(room,p){
  if(!p.alive)return;
  const gx=Math.floor(p.x/TILE),gy=Math.floor(p.y/TILE);
  if(p.kickCharges>0){
    for(const v of AI_DIRS){
      const bomb=findBombAt(room,gx+v.x,gy+v.y);
      if(bomb && !bomb.moving){startBombSlide(bomb,v.d,p);p.kickCharges--;return}
    }
  }
  const vec={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]}[p.dir];
  const tx=gx+vec[0],ty=gy+vec[1];
  if(p.canBreakCrates && room.blocks.has(tileKey(tx,ty))){
    room.blocks.delete(tileKey(tx,ty));
    const gotPowerup=maybeSpawnPowerup(room,tx,ty);
    p.stats.crates++;
    awardPoints(p,POINTS.crate);
    if(gotPowerup) awardPoints(p,POINTS.crateWithPowerup);
    return;
  }
  if(p.canRecallBomb && p.activeBombs>=p.bombCap){
    const b=room.bombs.find(b=>b.owner===p && !b.dead);
    if(b){b.dead=true;p.activeBombs=Math.max(0,p.activeBombs-1);return}
  }
  tryPlaceBomb(room,p);
}

function attemptAxis(room,p,dx,dy){
  const radius=18;
  const nx=p.x+dx,ny=p.y+dy;
  const points=[[nx-radius,ny-radius],[nx+radius,ny-radius],[nx-radius,ny+radius],[nx+radius,ny+radius]];
  let blocked=false;
  for(const [px,py] of points){
    const gx=Math.floor(px/TILE),gy=Math.floor(py/TILE);
    if(isSolidForPlayer(room,p,gx,gy)){blocked=true;break}
  }
  if(!blocked){p.x=nx;p.y=ny;return}
  if(p.kickCharges>0 && (Math.abs(dx)+Math.abs(dy))>0){
    const gx=Math.floor((nx+Math.sign(dx)*radius)/TILE);
    const gy=Math.floor((ny+Math.sign(dy)*radius)/TILE);
    const bomb=findBombAt(room,gx,gy);
    if(bomb && !bomb.moving){
      const dir=dx<0?"left":dx>0?"right":dy<0?"up":"down";
      startBombSlide(bomb,dir,p);
      p.kickCharges--;
    }
  }
}
function movePlayer(room,p,dx,dy){ attemptAxis(room,p,dx,0); attemptAxis(room,p,0,dy); }

function updateHumanFromInput(room,p,dt){
  const v=p.input||{x:0,y:0};
  if(v.x||v.y){
    if(Math.abs(v.x)>Math.abs(v.y))p.dir=v.x<0?"left":"right";
    else p.dir=v.y<0?"up":"down";
    p.moving=true;
    movePlayer(room,p,v.x*p.speed*dt,v.y*p.speed*dt);
  }else p.moving=false;
}

// ---- hand-designed bot AI ----
// No learning involved: a fixed priority list, re-evaluated a few times a second per bot.
//   1) In danger right now?              -> run to the nearest tile that isn't (the one case
//                                             where moving through danger is still allowed —
//                                             staying put is certain death).
//   2) A powerup one step away?          -> grab it immediately, don't get distracted.
//   3) Lined up on an enemy, safe to bomb? -> bomb them and retreat.
//   4) A powerup on the map?              -> path to the nearest one, but only via a route
//                                             that never crosses danger.
//   5) A reachable crate?                 -> path next to it (same danger-free rule), then
//                                             melee-break (if the species can) or bomb it
//                                             (only with a safe escape) and retreat.
//   6) An enemy anywhere?                 -> close the distance instead of waiting around.
//   7) Nothing to do?                     -> wander to a random open tile.
// Priorities 2 and 4-7 only ever move through tiles that are safe right now — a bot that
// isn't currently in danger never walks itself into a blast chasing an objective; if no
// danger-free route to anything exists, it just holds its ground instead (see
// bfsSafeStepToward below), which is exactly what should happen when a bot ends up boxed
// into a corner with nowhere safe to go — better to sit still than force a fatal detour.
// Movement is BFS pathfinding (a few hundred tile visits at most, trivially cheap) so bots
// take sensible routes instead of a 1-tile-lookahead greedy walk.

function dirBetween(fx,fy,tx,ty){
  if(tx>fx)return "right";
  if(tx<fx)return "left";
  if(ty>fy)return "down";
  return "up";
}

function bfsRun(room,p,sx,sy,isGoal,skipDanger){
  const visited=new Set([tileKey(sx,sy)]);
  const queue=[{x:sx,y:sy,first:null}];
  for(let qi=0;qi<queue.length;qi++){
    const cur=queue[qi];
    if(!(cur.x===sx&&cur.y===sy) && isGoal(cur.x,cur.y)) return cur.first;
    for(const v of AI_DIRS){
      const nx=cur.x+v.x, ny=cur.y+v.y, key=tileKey(nx,ny);
      if(visited.has(key)) continue;
      if(!canStandAt(room,p,nx,ny)) continue;
      if(skipDanger && isDangerTile(room,nx,ny)) continue;
      visited.add(key);
      queue.push({x:nx,y:ny,first:cur.first||{tx:nx,ty:ny}});
    }
  }
  return null;
}
// BFS from (sx,sy) to the nearest tile matching isGoal, crossing danger tiles if that's what
// it takes — only for the "I'm already in danger and must move" case.
function bfsStepToward(room,p,sx,sy,isGoal){
  return bfsRun(room,p,sx,sy,isGoal,false);
}
// Same, but the search never steps onto a tile that's dangerous right now — returns null
// (meaning: hold position) instead of routing through a blast to reach the goal.
function bfsSafeStepToward(room,p,sx,sy,isGoal){
  return bfsRun(room,p,sx,sy,isGoal,true);
}
// Same traversal rules as bfsSafeStepToward, but just answers "is any matching tile reachable
// within maxDepth steps" — used to check for an escape route before planting a bomb.
function bfsExists(room,p,sx,sy,isGoal,maxDepth){
  const visited=new Set([tileKey(sx,sy)]);
  const queue=[{x:sx,y:sy,d:0}];
  for(let qi=0;qi<queue.length;qi++){
    const cur=queue[qi];
    if(isGoal(cur.x,cur.y)) return true;
    if(cur.d>=maxDepth) continue;
    for(const v of AI_DIRS){
      const nx=cur.x+v.x, ny=cur.y+v.y, key=tileKey(nx,ny);
      if(visited.has(key) || !canStandAt(room,p,nx,ny) || isDangerTile(room,nx,ny)) continue;
      visited.add(key);
      queue.push({x:nx,y:ny,d:cur.d+1});
    }
  }
  return false;
}
// The conservative danger footprint of a bomb placed at (gx,gy) with the given range — same
// row/col within range, matching isDangerTile's own (wall-blind) hazard sensing, so a bot
// never talks itself into a "safe" escape that isDangerTile would actually flag as deadly.
function computeBombDangerTiles(gx,gy,range){
  const set=new Set([tileKey(gx,gy)]);
  for(let i=1;i<=range;i++){
    set.add(tileKey(gx+i,gy)); set.add(tileKey(gx-i,gy));
    set.add(tileKey(gx,gy+i)); set.add(tileKey(gx,gy-i));
  }
  return set;
}
function hasSafeEscapeIfBombed(room,p,gx,gy){
  const range=p.blast+(p.superBombs>0?2:0);
  const hypDanger=computeBombDangerTiles(gx,gy,range);
  return bfsExists(room,p,gx,gy,(x,y)=>!hypDanger.has(tileKey(x,y))&&!isDangerTile(room,x,y),6);
}
// Same row or column, within range, with no wall/crate breaking the line of the blast.
function isAlignedAndClear(room,gx,gy,tgx,tgy,range){
  if(gx===tgx && gy!==tgy){
    if(Math.abs(gy-tgy)>range) return false;
    const step=tgy>gy?1:-1;
    for(let y=gy+step;y!==tgy;y+=step) if(isFixedWall(gx,y)||room.blocks.has(tileKey(gx,y))) return false;
    return true;
  }
  if(gy===tgy && gx!==tgx){
    if(Math.abs(gx-tgx)>range) return false;
    const step=tgx>gx?1:-1;
    for(let x=gx+step;x!==tgx;x+=step) if(isFixedWall(x,gy)||room.blocks.has(tileKey(x,gy))) return false;
    return true;
  }
  return false;
}
function setMoveTarget(p,gx,gy,step){
  p.ai.tx=step.tx; p.ai.ty=step.ty; p.dir=dirBetween(gx,gy,step.tx,step.ty);
}
// Acts (bomb/kick/melee-break, via the same handleAction humans use) facing `dir`, then
// immediately plots a route out of the blast footprint of whatever bomb that just planted.
// handleAction() already adds the bomb to room.bombs before this runs, so isDangerTile alone
// (no separate hypothetical set needed) correctly reflects it.
function actAndRetreat(room,p,gx,gy,dir){
  p.dir=dir;
  handleAction(room,p);
  const step=bfsSafeStepToward(room,p,gx,gy,(x,y)=>!isDangerTile(room,x,y));
  if(step) setMoveTarget(p,gx,gy,step);
}
function tilesAdjacentToCrates(room){
  const set=new Set();
  for(const key of room.blocks){
    const [cx,cy]=key.split(",").map(Number);
    for(const v of AI_DIRS){
      const nx=cx+v.x, ny=cy+v.y;
      if(!isFixedWall(nx,ny) && !room.blocks.has(tileKey(nx,ny))) set.add(tileKey(nx,ny));
    }
  }
  return set;
}

function decideBotAction(room,p,gx,gy){
  // 1) Safety first — the one case where crossing danger is allowed, since standing still
  // here is certain death.
  if(isDangerTile(room,gx,gy)){
    const step=bfsStepToward(room,p,gx,gy,(x,y)=>!isDangerTile(room,x,y));
    if(step) setMoveTarget(p,gx,gy,step);
    return;
  }

  // 2) A powerup right next door — take the free pickup now instead of possibly getting
  // pulled toward a fight or a crate on the very next think-tick.
  if(room.powerups.length){
    const adjPow=AI_DIRS.map(v=>({x:gx+v.x,y:gy+v.y})).find(t=>room.powerups.some(u=>u.gx===t.x&&u.gy===t.y));
    if(adjPow && canStandAt(room,p,adjPow.x,adjPow.y) && !isDangerTile(room,adjPow.x,adjPow.y)){
      setMoveTarget(p,gx,gy,{tx:adjPow.x,ty:adjPow.y});
      return;
    }
  }

  const enemies=room.players.filter(e=>e!==p&&e.alive);
  const range=p.blast+(p.superBombs>0?2:0);

  // 3) A free, safe shot on someone — take it.
  for(const e of enemies){
    const egx=Math.floor(e.x/TILE), egy=Math.floor(e.y/TILE);
    if(isAlignedAndClear(room,gx,gy,egx,egy,range) && hasSafeEscapeIfBombed(room,p,gx,gy)){
      actAndRetreat(room,p,gx,gy,dirBetween(gx,gy,egx,egy));
      return;
    }
  }

  // 4) Path to the nearest powerup — only via a route that's danger-free the whole way.
  if(room.powerups.length){
    const goal=new Set(room.powerups.map(u=>tileKey(u.gx,u.gy)));
    const step=bfsSafeStepToward(room,p,gx,gy,(x,y)=>goal.has(tileKey(x,y)));
    if(step){ setMoveTarget(p,gx,gy,step); return; }
  }

  // 5) Break crates — melee if the species can (no blast risk), otherwise bomb one only
  // with a safe escape lined up.
  if(room.blocks.size){
    const adj=tilesAdjacentToCrates(room);
    if(adj.has(tileKey(gx,gy))){
      const target=AI_DIRS.map(v=>({x:gx+v.x,y:gy+v.y,d:v.d})).find(t=>room.blocks.has(tileKey(t.x,t.y)));
      if(target){
        if(p.canBreakCrates){ p.dir=target.d; handleAction(room,p); }
        else if(hasSafeEscapeIfBombed(room,p,gx,gy)) actAndRetreat(room,p,gx,gy,target.d);
        return;
      }
    }
    const step=bfsSafeStepToward(room,p,gx,gy,(x,y)=>adj.has(tileKey(x,y)));
    if(step){ setMoveTarget(p,gx,gy,step); return; }
  }

  // 6) Nobody to shoot, nothing to grab or break — go hunt instead of standing around.
  if(enemies.length){
    const enemyTiles=enemies.map(e=>({x:Math.floor(e.x/TILE),y:Math.floor(e.y/TILE)}));
    const step=bfsSafeStepToward(room,p,gx,gy,(x,y)=>enemyTiles.some(t=>Math.abs(t.x-x)+Math.abs(t.y-y)<=1));
    if(step){ setMoveTarget(p,gx,gy,step); return; }
  }

  // 7) Fallback wander — and if even that has no danger-free route (fully boxed in), do
  // nothing rather than force a move through a blast. Standing still in a safe corner beats
  // dying to reach an arbitrary open tile.
  const open=[];
  for(let y=1;y<ROWS-1;y++)for(let x=1;x<COLS-1;x++){
    if((x!==gx||y!==gy) && canStandAt(room,p,x,y) && !isDangerTile(room,x,y)) open.push({x,y});
  }
  if(open.length){
    const goal=open[Math.floor(Math.random()*open.length)];
    const step=bfsSafeStepToward(room,p,gx,gy,(x,y)=>x===goal.x&&y===goal.y);
    if(step) setMoveTarget(p,gx,gy,step);
  }
}

function updateBot(room,p,dt){
  p.ai.think-=dt;
  const gx=Math.floor(p.x/TILE), gy=Math.floor(p.y/TILE);
  if(p.ai.think<=0){
    p.ai.think=.12+Math.random()*.08; // reacts quickly — danger, openings and pickups don't wait around
    decideBotAction(room,p,gx,gy);
  }
  const tx=(p.ai.tx+.5)*TILE,ty=(p.ai.ty+.5)*TILE;
  let dx=tx-p.x,dy=ty-p.y;
  const dist=Math.hypot(dx,dy);
  if(dist>3){
    dx/=dist;dy/=dist;p.moving=true;movePlayer(room,p,dx*p.speed*.72*dt,dy*p.speed*.72*dt);
  }else p.moving=false;
}

function updateBombs(room,dt){
  for(const b of room.bombs){
    if(b.dead)continue;
    b.age+=dt;
    if(b.exempt.size){
      for(const pl of b.exempt) if(!playerOverlapsTile(pl,b.gx,b.gy)) b.exempt.delete(pl);
    }
    if(b.moving){
      const vec={left:[-1,0],right:[1,0],up:[0,-1],down:[0,1]}[b.dir];
      const nx=b.x+vec[0]*b.speed*dt,ny=b.y+vec[1]*b.speed*dt;
      const ngx=Math.floor((nx+vec[0]*24)/TILE),ngy=Math.floor((ny+vec[1]*24)/TILE);
      if(isFixedWall(ngx,ngy)||room.blocks.has(tileKey(ngx,ngy))||findBombAt(room,ngx,ngy,b)){
        b.moving=false;
        b.x=(b.gx+.5)*TILE;b.y=(b.gy+.5)*TILE;
      }else{
        b.x=nx;b.y=ny;
        const cgx=Math.floor(b.x/TILE),cgy=Math.floor(b.y/TILE);
        if(cgx!==b.gx||cgy!==b.gy){b.gx=cgx;b.gy=cgy}
      }
    }
    if(b.age>=b.fuse) explodeBomb(room,b);
  }
  room.bombs=room.bombs.filter(b=>!b.dead);
}
function explodeBomb(room,b){
  if(b.dead)return;
  b.dead=true;b.owner.activeBombs=Math.max(0,b.owner.activeBombs-1);
  const range=b.owner.blast+(b.powered?2:0);
  addBlast(room,b.gx,b.gy,b.powered,b.owner,b.wasKicked);
  for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
    for(let i=1;i<=range;i++){
      const x=b.gx+dx*i,y=b.gy+dy*i;
      if(isFixedWall(x,y))break;
      addBlast(room,x,y,b.powered,b.owner,b.wasKicked);
      const other=findBombAt(room,x,y);
      if(other){other.age=other.fuse;break}
      if(room.blocks.has(tileKey(x,y))){
        room.blocks.delete(tileKey(x,y));
        const gotPowerup=maybeSpawnPowerup(room,x,y);
        b.owner.stats.crates++;
        awardPoints(b.owner,POINTS.crate);
        if(gotPowerup) awardPoints(b.owner,POINTS.crateWithPowerup);
        break;
      }
    }
  }
}
function addBlast(room,gx,gy,powered,owner,wasKicked){
  room.blasts.push({gx,gy,life:.48,max:.48,powered,owner,wasKicked});
  for(const p of room.players){
    if(!p.alive||p.invuln>0)continue;
    const px=Math.floor(p.x/TILE),py=Math.floor(p.y/TILE);
    if(px===gx&&py===gy) damagePlayer(room,p,owner,powered,wasKicked);
  }
}
function damagePlayer(room,p,owner,powered,wasKicked){
  p.lives--;
  if(p.lives<=0){
    p.alive=false;p.deathTime=.9;p.moving=false;
    awardPoints(p,POINTS.death);
    if(owner && owner!==p){
      owner.stats.kills++;
      // Double points for a kill scored with a bomb that was pushed or powered-up — rewards
      // using those tools offensively, not just as a fallback.
      const special=powered||wasKicked;
      awardPoints(owner,POINTS.kill*(special?2:1));
    }
    if(owner===p){
      p.stats.suicides++;
      awardPoints(p,POINTS.ownBombDeath);
    }
  }else{
    p.invuln=1.3;
    const sp=p.spawn||[1,1];
    p.x=(sp[0]+.5)*TILE;p.y=(sp[1]+.5)*TILE;
  }
}
function updateBlasts(room,dt){
  for(const e of room.blasts)e.life-=dt;
  room.blasts=room.blasts.filter(e=>e.life>0);
  for(const p of room.players){
    if(!p.alive||p.invuln>0)continue;
    const gx=Math.floor(p.x/TILE),gy=Math.floor(p.y/TILE);
    const hit=room.blasts.find(e=>e.gx===gx&&e.gy===gy);
    if(hit){damagePlayer(room,p,hit.owner,hit.powered,hit.wasKicked)}
  }
}
function maybeSpawnPowerup(room,gx,gy){
  if(Math.random()>.34)return false;
  const kinds=["range","speed","bomb","kick","super","power"];
  room.powerups.push({gx,gy,kind:kinds[Math.floor(Math.random()*kinds.length)],pulse:Math.random()*6});
  return true;
}
function updatePowerups(room,dt){
  for(const u of room.powerups)u.pulse+=dt*4;
  for(const p of room.players){
    if(!p.alive)continue;
    const gx=Math.floor(p.x/TILE),gy=Math.floor(p.y/TILE);
    const i=room.powerups.findIndex(u=>u.gx===gx&&u.gy===gy);
    if(i>=0){
      const u=room.powerups.splice(i,1)[0];
      p.stats.powerups++;
      awardPoints(p,POINTS.powerup);
      if(u.kind==="range")p.blast=Math.min(7,p.blast+1);
      if(u.kind==="speed")p.speed=Math.min(270,p.speed+18);
      if(u.kind==="bomb")p.bombCap=Math.min(5,p.bombCap+1);
      if(u.kind==="kick")p.kickCharges+=3;
      if(u.kind==="super")p.superBombs++;
      if(u.kind==="power")grantSpeciesPower(p);
    }
  }
}
function grantSpeciesPower(p){
  const power=SPECIES[p.species].power;
  if(power==="jump")p.canJumpCrates=true;
  if(power==="break")p.canBreakCrates=true;
  if(power==="recall")p.canRecallBomb=true;
  if(power==="ghost")p.ghostBombs=true;
}
function isDangerTile(room,gx,gy){
  for(const b of room.bombs){
    if(b.gx===gx&&b.gy===gy)return true;
    const range=b.owner.blast+(b.powered?2:0);
    if(b.gx===gx&&Math.abs(b.gy-gy)<=range)return true;
    if(b.gy===gy&&Math.abs(b.gx-gx)<=range)return true;
  }
  return room.blasts.some(e=>e.gx===gx&&e.gy===gy);
}

function tick(room,dt,restartDelayMs){
  if(!room.running)return;
  for(const p of room.players){
    if(!p.alive)continue;
    if(p.socket) updateHumanFromInput(room,p,dt);
    else updateBot(room,p,dt);
  }
  updateBombs(room,dt);
  updateBlasts(room,dt);
  updatePowerups(room,dt);
  for(const p of room.players){
    p.invuln=Math.max(0,p.invuln-dt);
    p.plantAnim=Math.max(0,p.plantAnim-dt);
    if(p.alive){
      p.aliveTime+=dt;
      p.idleTimer+=dt;
      if(p.idleTimer>=IDLE_BOMB_TIMEOUT){
        awardPoints(p,POINTS.idle);
        p.idleTimer=0; // keeps re-applying every IDLE_BOMB_TIMEOUT seconds while they keep stalling
      }
    }else p.deathTime=Math.max(0,p.deathTime-dt);
  }
  room.roundElapsed+=dt;
  const alive=room.players.filter(p=>p.alive);
  const isTimeout=room.roundElapsed>ROUND_TIMEOUT && alive.length>1;
  // If a human was playing and none are left alive, the round is over for them right then —
  // no reason to make them wait for the remaining bots to fight it out on their own. This
  // also naturally covers a round that reaches its normal end (elimination/timeout) with no
  // human among the survivors.
  const hasHuman=room.players.some(p=>p.socket);
  const humanAlive=room.players.some(p=>p.socket&&p.alive);
  const noHumanLeft=hasHuman && !humanAlive;
  if((alive.length<=1 || isTimeout || noHumanLeft) && room.running){
    room.running=false;
    // Stalling a round out to a timeout is punished hard — nobody should be able to "win"
    // by just surviving passively (or jittering in place) without ever finishing it.
    if(isTimeout){
      for(const p of alive) awardPoints(p,POINTS.timeoutDraw);
    }
    // The winner is whoever scored the most points this round, not just whoever's left
    // standing — a bot that racks up kills and then dies can still out-score, and beat,
    // whoever just outlasted everyone. A tie for the top score is a draw.
    let winner=null, tied=false;
    for(const p of room.players){
      if(!winner || p.stats.points>winner.stats.points){winner=p;tied=false}
      else if(p.stats.points===winner.stats.points) tied=true;
    }
    if(tied) winner=null;
    // On top of that, a winner who never landed a single kill is still docked — winning by
    // out-farming crates/powerups alone shouldn't be as good as actually fighting.
    if(winner && winner.stats.kills===0){
      awardPoints(winner,POINTS.hollowWin);
    }
    room.message=winner?`${SPECIES[winner.species].name} venceu!`:(isTimeout?"Tempo esgotado — empate!":"Empate!");
    if(noHumanLeft){
      // Don't silently keep auto-restarting an empty-of-humans room forever — pause and let
      // whoever's still connected choose to play again or head back to the room screen.
      room.awaitingRestart=true;
    }else{
      setTimeout(()=>{ initRound(room); },restartDelayMs??4000);
    }
  }
}

function serializePlayer(p){
  return {species:p.species,index:p.index,bot:!p.socket,x:p.x,y:p.y,dir:p.dir,moving:p.moving,
    lives:p.lives,blast:p.blast,bombCap:p.bombCap,activeBombs:p.activeBombs,speed:p.speed,
    kickCharges:p.kickCharges,ghostBombs:p.ghostBombs,canJumpCrates:p.canJumpCrates,canBreakCrates:p.canBreakCrates,
    canRecallBomb:p.canRecallBomb,superBombs:p.superBombs,alive:p.alive,invuln:p.invuln,plantAnim:p.plantAnim,deathTime:p.deathTime,nickname:p.nickname};
}
function serializeRoom(room){
  return {
    players: room.players.map(serializePlayer),
    bombs: room.bombs.map(b=>({gx:b.gx,gy:b.gy,x:b.x,y:b.y,age:b.age,fuse:b.fuse,powered:b.powered,moving:b.moving,dir:b.dir})),
    blasts: room.blasts.map(e=>({gx:e.gx,gy:e.gy,life:e.life,max:e.max,powered:e.powered})),
    powerups: room.powerups.map(u=>({gx:u.gx,gy:u.gy,kind:u.kind,pulse:u.pulse})),
    blocks: Array.from(room.blocks),
    message: room.message,
    awaitingRestart: !!room.awaitingRestart
  };
}

module.exports = { TILE, COLS, ROWS, SPECIES, SPECIES_ORDER, createRoom, initRound, tick, serializeRoom, handleAction, tryPlaceBomb };
