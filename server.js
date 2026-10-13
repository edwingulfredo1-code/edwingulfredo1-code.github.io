/* STORMFALL ARENA - Servidor multijugador local/Internet.
   Node.js >=18. No requiere npm ni librerías externas.
   Simulación autoritativa: movimiento, armas, golpes, vidas, paredes y tormenta. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BASE = __dirname;
const TAU = Math.PI * 2, SIZE = 2600, CENTER = 1300;
const rooms = new Map();
const weapons = [
  {mag:30, damage:19, cooldown:.122, speed:1030, spread:.048, life:1.2, reload:1.4, color:'#71dfff'},
  {mag:6, damage:13, cooldown:.70, speed:900, spread:.24, life:.65, reload:1.9, color:'#ffc16c'}
];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const dst=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const vec=a=>({x:Math.cos(a),y:Math.sin(a)});
const cleanName=s=>String(s||'JUGADOR').replace(/[<>\x00-\x1f]/g,'').trim().slice(0,18)||'JUGADOR';
const random=(a,b)=>a+Math.random()*(b-a);
const code=()=>crypto.randomBytes(3).toString('hex').slice(0,5).toUpperCase();
function mapObjects(){let seed=777;const rnd=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296};
  const range=(a,b)=>a+(b-a)*rnd();
  for(let i=0;i<105;i++){range(30,2570);range(30,2570);range(30,115);range(22,80)}
  for(let i=0;i<520;i++){range(0,2600);range(0,2600);range(3,9);rnd()}
  let out=[];for(let i=0;i<130;i++){
    let x=range(80,2520),y=range(80,2520),type=rnd()<.51?'tree':rnd()<.70?'rock':'crate';
    let r=type==='tree'?range(21,34):type==='rock'?range(20,31):23;
    if(Math.hypot(x-CENTER,y-CENTER)<150)continue;
    if(out.some(o=>Math.hypot(o.x-x,o.y-y)<o.r+r+10))continue;
    out.push({x,y,r,type,tint:rnd(),rot:rnd()*TAU});
  }
  return out;
}
const OBJECTS=mapObjects();
function pointSeg(px,py,x1,y1,x2,y2){let dx=x2-x1,dy=y2-y1,t=clamp(((px-x1)*dx+(py-y1)*dy)/(dx*dx+dy*dy||1),0,1);return Math.hypot(px-(x1+dx*t),py-(y1+dy*t));}
function wallEnds(w){let a=vec(w.angle);return [w.x-a.x*38,w.y-a.y*38,w.x+a.x*38,w.y+a.y*38];}
function blocked(room,x,y,r=17){if(x<r||y<r||x>SIZE-r||y>SIZE-r)return true;
  for(const o of OBJECTS)if(Math.hypot(x-o.x,y-o.y)<r+o.r*.78)return true;
  for(const w of room.walls){const e=wallEnds(w);if(pointSeg(x,y,...e)<r+10)return true;}
  return false;
}
function move(room,p,dx,dy){let ox=p.x,oy=p.y;p.x+=dx;if(blocked(room,p.x,p.y,p.r))p.x=ox;p.y+=dy;if(blocked(room,p.x,p.y,p.r))p.y=oy;p.walk+=Math.hypot(p.x-ox,p.y-oy)*.09;}
function spawn(room,min=180){for(let i=0;i<550;i++){
  let a=Math.random()*TAU,r=random(min,1090),x=CENTER+Math.cos(a)*r,y=CENTER+Math.sin(a)*r;
  if(blocked(room,x,y,24))continue;
  if([...room.players.values(),...room.bots].some(p=>p.alive&&Math.hypot(p.x-x,p.y-y)<min))continue;
  return {x,y};
}return {x:CENTER,y:CENTER};}
const send=(client,data)=>{if(!client||!client.socket||client.socket.destroyed||client.socket.writableLength>1e6)return;try{
  let payload=Buffer.from(JSON.stringify(data));
  let hdr=payload.length<126?Buffer.from([0x81,payload.length]):payload.length<65536?Buffer.from([0x81,126,payload.length>>8,payload.length&255]):Buffer.from([0x81,127,0,0,0,0,(payload.length/16777216)&255,(payload.length>>16)&255,(payload.length>>8)&255,payload.length&255]);
  client.socket.write(Buffer.concat([hdr,payload]));
}catch{}}
const broadcast=(r,data)=>{for(const p of r.players.values())send(p.conn,data);};
function roster(r){broadcast(r,{type:'lobby',room:r.code,host:r.host,phase:r.phase,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,connected:true})),max:8});}
function roomState(r){return {type:'state',phase:r.phase,elapsed:+r.elapsed.toFixed(2),storm:+r.storm.toFixed(1),winner:r.winner,alive:[...r.players.values(),...r.bots].filter(x=>x.alive).length,players:[...r.players.values()].map(simplify),bots:r.bots.filter(x=>x.alive).map(simplify),walls:r.walls,pickups:r.pickups,projectiles:r.projectiles.map(b=>({x:b.x,y:b.y,vx:b.vx,vy:b.vy,color:b.color}))};}
function simplify(p){return {id:p.id,name:p.name,x:+p.x.toFixed(1),y:+p.y.toFixed(1),r:p.r,hp:+p.hp.toFixed(1),shield:+p.shield.toFixed(1),angle:+p.angle.toFixed(3),weapon:p.weapon,ammo:p.ammo,reserve:p.reserve,mat:p.mat,dashCd:+p.dashCd.toFixed(1),reloading:+p.reloading.toFixed(1),reloadTotal:p.reloadTotal,walk:+p.walk.toFixed(2),alive:p.alive,kills:p.kills,skin:p.skin};}
function createRoom(){let c=code();while(rooms.has(c))c=code();let r={code:c,phase:'lobby',host:null,players:new Map(),bots:[],projectiles:[],walls:[],pickups:[],elapsed:0,storm:1340,winner:null,lastPublished:0,seed:Date.now()};rooms.set(c,r);return r;}
function actor(id,name,bot=false){return {id,name,bot,conn:null,x:CENTER,y:CENTER,r:bot?16:18,hp:100,shield:bot?random(5,35):50,speed:bot?random(100,140):225,angle:0,weapon:0,ammo:[30,6],reserve:[120,36],mat:200,dashCd:0,dashTime:0,walk:0,reloading:0,reloadTotal:0,cooldown:0,alive:true,kills:0,skin:Math.floor(Math.random()*4),input:{dx:0,dy:0,angle:0,shoot:false,run:false},aiTimer:0,offset:random(0,TAU),strafe:Math.random()<.5?-1:1};}
function startGame(r){r.elapsed=0;r.storm=1340;r.winner=null;r.phase='playing';r.bots=[];r.projectiles=[];r.walls=[];r.pickups=[];
  for(const p of r.players.values()){let pos=spawn(r,80);Object.assign(p,actor(p.id,p.name,false),pos,{conn:p.conn});}
  const names=['Fénix','Lobo','Eclipse','Vector','Ghost','Titan','Rayo','Nébula','Sombra','Furia','Nova','Magma','Delta','Hunter','Cometa','Turbo'];
  const botCount=Math.max(6,14-r.players.size);
  for(let i=0;i<botCount;i++){let b=actor('b'+i,names[i],true);Object.assign(b,spawn(r,175));r.bots.push(b);}
  for(let i=0;i<60;i++){const point=spawn(r,30),n=Math.random();r.pickups.push({id:'p'+i,x:point.x,y:point.y,type:n<.28?'ammo':n<.53?'shield':n<.72?'med':'mat',phase:random(0,TAU)});}
  broadcast(r,{type:'started',room:r.code});
  publish(r);
}
function reload(p){let i=p.weapon;if(!p.alive||p.reloading>0||p.reserve[i]<=0||p.ammo[i]>=weapons[i].mag)return;p.reloadTotal=weapons[i].reload;p.reloading=p.reloadTotal;}
function fire(r,p){if(!p.alive||p.reloading>0||p.cooldown>0)return;
  let i=p.weapon,g=weapons[i];if(p.ammo[i]<=0){reload(p);return;}
  p.ammo[i]--;p.cooldown=g.cooldown;
  let count=i===0?1:8;
  for(let j=0;j<count;j++){let a=p.angle+random(-g.spread,g.spread),v=vec(a);
    r.projectiles.push({x:p.x+Math.cos(p.angle)*24,y:p.y+Math.sin(p.angle)*24,vx:v.x*g.speed,vy:v.y*g.speed,life:g.life,damage:g.damage,owner:p.id,color:g.color});
  }
}
function build(r,p){if(!p.alive||p.mat<25||r.walls.length>250)return;
  const a=p.angle,x=p.x+Math.cos(a)*84,y=p.y+Math.sin(a)*84;
  if(x<50||x>SIZE-50||y<50||y>SIZE-50||OBJECTS.some(o=>Math.hypot(x-o.x,y-o.y)<o.r+26)||r.walls.some(w=>Math.hypot(w.x-x,w.y-y)<40))return;
  p.mat-=25;r.walls.push({id:crypto.randomBytes(4).toString('hex'),x,y,angle:a+Math.PI/2,hp:160,maxHp:160});
}
function event(r,kind,message,target){if(target){let p=r.players.get(target);if(p)send(p.conn,{type:'event',kind,message});}else broadcast(r,{type:'event',kind,message});}
function damage(r,p,amount,source){if(!p.alive)return;let sh=Math.min(p.shield,amount);p.shield-=sh;p.hp-=amount-sh;if(p.hp>0)return;
  p.hp=0;p.alive=false;
  const killer=r.players.get(source)||r.bots.find(x=>x.id===source);
  if(killer&&killer!==p){killer.kills++;if(!killer.bot)event(r,'kill','✦ ¡ELIMINACIÓN! +1',killer.id);}
  event(r,'feed',(killer?killer.name:'Tormenta')+' eliminó a '+p.name);
  r.pickups.push({id:crypto.randomBytes(4).toString('hex'),x:p.x+random(-20,20),y:p.y+random(-20,20),type:'ammo',phase:random(0,TAU)});
  r.pickups.push({id:crypto.randomBytes(4).toString('hex'),x:p.x+random(-20,20),y:p.y+random(-20,20),type:'shield',phase:random(0,TAU)});
}
function updateProjectiles(r,dt){const targets=[...r.players.values(),...r.bots];
  for(let i=r.projectiles.length-1;i>=0;i--){let b=r.projectiles[i],oldX=b.x,oldY=b.y;b.x+=b.vx*dt;b.y+=b.vy*dt;b.life-=dt;let hit=b.life<=0||b.x<0||b.x>SIZE||b.y<0||b.y>SIZE;
    if(!hit)for(const o of OBJECTS){if(pointSeg(o.x,o.y,oldX,oldY,b.x,b.y)<o.r*.75+3){hit=true;break;}}
    if(!hit)for(let j=r.walls.length-1;j>=0;j--){const w=r.walls[j],e=wallEnds(w);if(pointSeg(b.x,b.y,...e)<10||pointSeg(oldX,oldY,...e)<10||pointSeg(w.x,w.y,oldX,oldY,b.x,b.y)<45){ // approximation plus projection
        // Reject distant intersections to avoid phantom hits from the last wide test.
        const distNow=pointSeg(b.x,b.y,...e),distPrev=pointSeg(oldX,oldY,...e);
        if(distNow>=10&&distPrev>=10&&pointSeg(w.x,w.y,oldX,oldY,b.x,b.y)>13)continue;
        w.hp-=b.damage;if(w.hp<=0)r.walls.splice(j,1);hit=true;break;
      }}
    if(!hit)for(const p of targets){if(!p.alive||p.id===b.owner)continue;if(pointSeg(p.x,p.y,oldX,oldY,b.x,b.y)<p.r+3){damage(r,p,b.damage,b.owner);hit=true;break;}}
    if(hit)r.projectiles.splice(i,1);
  }
}
function closest(r,p,range){let target=null,best=range;for(const other of [...r.players.values(),...r.bots]){if(other===p||!other.alive)continue;let d=dst(p,other);if(d<best){best=d;target=other;}}return target;}
function botAI(r,b,dt){let danger=Math.hypot(b.x-CENTER,b.y-CENTER)>r.storm-35;
  if(danger){let a=Math.atan2(CENTER-b.y,CENTER-b.x);b.angle=a;move(r,b,Math.cos(a)*b.speed*dt*1.7,Math.sin(a)*b.speed*dt*1.7);}
  else {b.aiTimer-=dt;if(b.aiTimer<=0){b.target=closest(r,b,620)?.id||null;b.aiTimer=random(.2,.4);}
    const target=[...r.players.values(),...r.bots].find(p=>p.id===b.target&&p.alive);
    if(target){let dis=dst(b,target),a=Math.atan2(target.y-b.y,target.x-b.x);b.angle=a+Math.sin(r.elapsed*2+b.offset)*.028;
      let fwd=dis>200?1:dis<130?-1:0,side=Math.sin(r.elapsed*.95+b.offset)*b.strafe*.65;
      let dx=Math.cos(a)*fwd+Math.cos(a+Math.PI/2)*side,dy=Math.sin(a)*fwd+Math.sin(a+Math.PI/2)*side,n=Math.max(1,Math.hypot(dx,dy));move(r,b,dx/n*b.speed*dt,dy/n*b.speed*dt);
      if(dis<520&&b.cooldown<=0){const a2=a+random(-.16,.16)+(dis/520)*random(-.12,.12),v=vec(a2);
        r.projectiles.push({x:b.x+Math.cos(a)*23,y:b.y+Math.sin(a)*23,vx:v.x*720,vy:v.y*720,life:1.06,damage:random(7,12),owner:b.id,color:'#ff9b80'});b.cooldown=random(.5,1.3);}}
    else{let a=Math.atan2(CENTER-b.y,CENTER-b.x)+Math.sin(r.elapsed*.6+b.offset)*1.4;b.angle=a;move(r,b,Math.cos(a)*b.speed*dt*.55,Math.sin(a)*b.speed*dt*.55);}}
}
function pickup(r,p){for(let i=r.pickups.length-1;i>=0;i--){let loot=r.pickups[i];if(dst(p,loot)>=34)continue;
  switch(loot.type){case'med':if(p.hp>=100)continue;p.hp=Math.min(100,p.hp+35);break;
    case'shield':if(p.shield>=100)continue;p.shield=Math.min(100,p.shield+35);break;
    case'mat':p.mat=Math.min(500,p.mat+50);break;
    case'ammo':p.reserve[0]+=35;p.reserve[1]+=6;break;}
  r.pickups.splice(i,1);
  if(!p.bot)event(r,'loot',{med:'BOTIQUÍN +35',shield:'ESCUDO +35',ammo:'MUNICIÓN RECOGIDA',mat:'MATERIALES +50'}[loot.type],p.id);
}}
function tick(r,dt){if(r.phase!=='playing')return;
  r.elapsed+=dt;r.storm=r.elapsed<12?1340:Math.max(155,1340-(r.elapsed-12)/210*1185);
  for(const p of [...r.players.values(),...r.bots]){
    if(!p.alive)continue;
    p.cooldown=Math.max(0,p.cooldown-dt);p.dashCd=Math.max(0,p.dashCd-dt);
    if(p.reloading>0){p.reloading=Math.max(0,p.reloading-dt);if(p.reloading===0){let i=p.weapon,qty=Math.min(weapons[i].mag-p.ammo[i],p.reserve[i]);p.ammo[i]+=qty;p.reserve[i]-=qty;}}
    if(p.bot)botAI(r,p,dt);
    else{
      let input=p.input,dx=input.dx,dy=input.dy,n=Math.max(1,Math.hypot(dx,dy));dx/=n;dy/=n;
      p.angle=input.angle;
      let speed=p.speed*(input.run?1.34:1);
      if(p.dashTime>0){p.dashTime-=dt;dx=Math.cos(p.angle);dy=Math.sin(p.angle);speed=970;}
      move(r,p,dx*speed*dt,dy*speed*dt);
      if(input.shoot)fire(r,p);
    }
    if(Math.hypot(p.x-CENTER,p.y-CENTER)>r.storm)damage(r,p,(p.bot?10:8)*dt,null);
    if(p.alive)pickup(r,p);
  }
  updateProjectiles(r,dt);
  let alive=[...r.players.values(),...r.bots].filter(p=>p.alive);
  if(alive.length<=1){r.phase='finished';r.winner=alive[0]?{id:alive[0].id,name:alive[0].name}:null;event(r,'feed',r.winner?'🏆 Ganó '+r.winner.name:'¡La tormenta ganó!');}
  r.lastPublished+=dt;if(r.lastPublished>=.066||r.phase==='finished'){r.lastPublished=0;publish(r);}
}
function publish(r){const state=roomState(r);broadcast(r,state);}
function leave(conn){if(!conn.room)return;let r=conn.room;conn.room=null;const p=r.players.get(conn.id);if(!p)return;r.players.delete(conn.id);
  if(r.host===conn.id)r.host=r.players.keys().next().value||null;
  if(!r.players.size){rooms.delete(r.code);return;}
  event(r,'feed',p.name+' salió de la sala');roster(r);
  if(r.phase==='playing'){publish(r);}
}
function onMessage(conn,data){if(!data||typeof data!=='object'||Array.isArray(data))return;
  if(data.type==='create'||data.type==='join'){
    if(conn.room){send(conn,{type:'error',message:'Ya estás dentro de una sala.'});return;}
    let r;if(data.type==='create')r=createRoom();else r=rooms.get(String(data.room||'').trim().toUpperCase());
    if(!r){send(conn,{type:'error',message:'No existe esa sala. Revisa el código.'});return;}
    if(r.phase!=='lobby'){send(conn,{type:'error',message:'La partida ya comenzó. Espera a la siguiente sala.'});return;}
    if(r.players.size>=8){send(conn,{type:'error',message:'La sala está llena (máximo 8 amigos).'});return;}
    const p=actor(conn.id,cleanName(data.name));p.conn=conn;conn.room=r;r.players.set(p.id,p);
    if(!r.host)r.host=p.id;
    send(conn,{type:'joined',id:conn.id,room:r.code});roster(r);return;
  }
  const r=conn.room;if(!r)return;
  const p=r.players.get(conn.id);if(!p)return;
  if(data.type==='leave'){leave(conn);return;}
  if(data.type==='start'&&r.host===p.id&&r.phase!=='playing'){startGame(r);return;}
  if(r.phase!=='playing'||!p.alive)return;
  if(data.type==='input'){
    // Inputs son controles, nunca posiciones, vida, munición ni daño.
    let dx=clamp(Number(data.dx)||0,-1,1),dy=clamp(Number(data.dy)||0,-1,1),aim=Number(data.angle);
    if(!Number.isFinite(aim))aim=p.angle;
    p.input={dx,dy,angle:clamp(aim,-100,100),shoot:data.shoot===true,run:data.run===true};
    if(data.weapon===0||data.weapon===1){if(p.weapon!==data.weapon){p.weapon=data.weapon;p.reloading=0;p.cooldown=Math.max(.15,p.cooldown);}}
  }else if(data.type==='build')build(r,p);
  else if(data.type==='dash'){if(p.dashCd<=0){p.dashCd=3.7;p.dashTime=.15;}}
  else if(data.type==='reload')reload(p);
}
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');const pathName=url.pathname==='/'?'/index.html':url.pathname;
  if(pathName==='/server-info'){
    let ips=[];for(const nets of Object.values(os.networkInterfaces()))for(const nic of nets||[]){
      if(nic.family==='IPv4'&&!nic.internal&&/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(nic.address))ips.push(nic.address);
    }
    ips.sort((a,b)=>Number(b.startsWith('192.168.'))-Number(a.startsWith('192.168.')));
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    return res.end(JSON.stringify({ips}));
  }
  const allowed={'/index.html':'index.html','/Stormfall_Arena_Original.html':'Stormfall_Arena_Original.html'};
  let file=allowed[pathName];if(!file){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('404 - No encontrado');}
  fs.readFile(path.join(BASE,file),(err,data)=>{if(err){res.writeHead(500);res.end();return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);});
});
server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||!/^[-+\w/=]{20,}$/.test(req.headers['sec-websocket-key']||'')){socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  let conn={id:crypto.randomUUID(),socket,room:null,buf:Buffer.alloc(0)};
  socket.setNoDelay(true);
  socket.on('data',chunk=>{
    if(conn.buf.length+chunk.length>131072){socket.destroy();return;}
    conn.buf=Buffer.concat([conn.buf,chunk]);
    while(conn.buf.length>=2){
      const b=conn.buf,opcode=b[0]&15,masked=Boolean(b[1]&128);let len=b[1]&127,offset=2;
      if(len===126){if(b.length<4)break;len=b.readUInt16BE(2);offset=4;}
      else if(len===127){if(b.length<10)break;const high=b.readUInt32BE(2);if(high||b.readUInt32BE(6)>65536){socket.destroy();return;}len=b.readUInt32BE(6);offset=10;}
      if(!masked||len>65536){socket.destroy();return;}
      if(b.length<offset+4+len)break;
      const mask=b.subarray(offset,offset+4),payload=Buffer.from(b.subarray(offset+4,offset+4+len));
      conn.buf=b.subarray(offset+4+len);
      for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];
      if(opcode===8){socket.end();return;}
      if(opcode===9){const h=Buffer.from([0x8a,payload.length]);socket.write(Buffer.concat([h,payload]));continue;}
      if(opcode!==1)continue;
      try{onMessage(conn,JSON.parse(payload.toString('utf8')));}catch{};
    }
  });
  socket.on('error',()=>{});socket.on('close',()=>leave(conn));socket.on('end',()=>leave(conn));
  if(head.length)socket.emit('data',head);
});
let previous=process.hrtime.bigint();
setInterval(()=>{
  const now=process.hrtime.bigint(),dt=clamp(Number(now-previous)/1e9,0,.06);previous=now;
  for(const r of rooms.values())tick(r,dt);
},1000/30);
server.listen(PORT,HOST,()=>{
  console.log('\n=============================================');
  console.log('  STORMFALL ARENA - MULTIJUGADOR');
  console.log('  Abre en Chrome: http://localhost:'+PORT);
  console.log('  Amigos en tu Wi-Fi: http://TU_IP_LOCAL:'+PORT);
  console.log('  Ctrl + C para cerrar el servidor');
  console.log('=============================================\n');
});
