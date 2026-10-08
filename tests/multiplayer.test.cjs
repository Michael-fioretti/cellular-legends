const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomBytes,randomUUID}=require('node:crypto');
const {createGameServer}=require('../server.cjs');
const sharedRules=require('../game-rules.cjs').loadGameRules();

const token=()=>randomBytes(32).toString('hex');
const clone=value=>JSON.parse(JSON.stringify(value));

async function fixture(t,options={}){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'cellular-multiplayer-'));
 const fixture={dataDir,app:createGameServer({dataDir,port:0,tickIntervalMs:250,...options})};
 await fixture.app.listen();
 fixture.request=async function(method,pathname,body,sessionToken){
  const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(sessionToken)headers.Authorization='Bearer '+sessionToken;
  const response=await fetch(fixture.app.url+pathname,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{assert.fail('Expected JSON from '+method+' '+pathname+', received '+response.status+': '+text.slice(0,300));}
  return {status:response.status,ok:response.ok,data};
 };
 fixture.command=(player,command,payload={},requestId=randomUUID())=>fixture.request('POST','/api/squads/'+player.code+'/command',{command,payload,requestId},player.token);
 fixture.read=player=>fixture.request('GET','/api/squads/'+player.code,undefined,player.token);
 t.after(async()=>{await fixture.app.close();await fs.rm(dataDir,{recursive:true,force:true});});
 return fixture;
}

function accepted(result){assert.ok(result.ok,JSON.stringify(result.data));return result.data;}
function rejected(result){assert.ok(result.status>=400&&result.status<500,'Expected a client rejection, received '+result.status+': '+JSON.stringify(result.data));return result.data;}
function assertNoCredentials(data,secrets){const serialized=JSON.stringify(data);for(const secret of secrets)assert.ok(!serialized.includes(secret),'Public squad state must not contain a credential');}

async function create(f,name='Host'){
 const sessionToken=token(),result=accepted(await f.request('POST','/api/squads',{name,sessionToken}));
 assert.ok(result.playerId);assert.equal(result.state.hostId,result.playerId);assert.equal(result.host,true);
 return {code:result.state.code,id:result.playerId,token:sessionToken};
}
async function invitation(f,host){
 const result=accepted(await f.request('POST','/api/squads/'+host.code+'/invite',{requestId:randomUUID()},host.token));
 assert.ok(typeof result.inviteUrl==='string');
 const hash=new URL(result.inviteUrl,'http://localhost').hash.slice(1),params=new URLSearchParams(hash);
 assert.equal(params.get('join'),host.code);assert.match(params.get('invite'),/^[a-f0-9]{64}$/i);
 return params.get('invite');
}
async function join(f,host,name='Guest',invite){
 const sessionToken=token();invite??=await invitation(f,host);
 const result=accepted(await f.request('POST','/api/squads/'+host.code+'/join',{name,invite,sessionToken}));
 assert.equal(result.host,false);assert.ok(result.playerId);assert.notEqual(result.playerId,host.id);
 return {code:host.code,id:result.playerId,token:sessionToken};
}
async function pair(f){const host=await create(f),guest=await join(f,host);return {host,guest};}
async function chooseClasses(f,host,guest){
 accepted(await f.command(host,'class',{classKey:'enzym'}));
 accepted(await f.command(guest,'class',{classKey:'macrofaag'}));
}
async function startBattle(f,host,guest){
 await chooseClasses(f,host,guest);
 accepted(await f.command(host,'preferences',{questionMode:'easy'}));
 accepted(await f.command(guest,'preferences',{questionMode:'easy'}));
 accepted(await f.command(host,'ready',{ready:true}));
 accepted(await f.command(guest,'ready',{ready:true}));
 const result=accepted(await f.command(host,'start'));
 assert.equal(result.state.status,'battle');return result.state;
}
async function arrangeTurn(f,player,round=1){
 await f.app.store.update(player.code,record=>{
  const s=record.state??record,b=s.battle,players=Object.values(s.members),enemyIds=b.enemies.map(e=>e.id);
  for(const m of players){m.hp=m.maxHp=1000;m.atp=m.maxAtp=200;m.level=5;}
  for(const e of b.enemies){e.hp=e.maxHp=1000;e.damage=20;}
  const ids=[player.id,...players.map(m=>m.id).filter(id=>id!==player.id),...enemyIds];
  b.initiative=ids.map(id=>({id,name:s.members[id]?.name??b.enemies.find(e=>e.id===id).name,side:s.members[id]?'player':'enemy',total:10}));
  b.turnQueue=ids;b.turnIndex=0;b.turnNumber+=10;b.round=round;b.phase='player';b.activePlayerId=b.activeActorId=player.id;
  b.deadline=Date.now()+120000;
  b.enemyHp=b.enemies.reduce((sum,e)=>sum+e.hp,0);b.maxEnemyHp=b.enemyHp;
 });
 return accepted(await f.read(player)).state;
}
async function quiz(f,player,state){
 const response=accepted(await f.request('POST','/api/squads/'+player.code+'/quiz',{battleId:state.battle.id,turnNumber:state.battle.turnNumber},player.token));
 assert.ok(response.question?.id);assert.ok(Array.isArray(response.question.options));
 return response.question;
}
function answerFor(question){
 const {QUESTION_DATABASE}=sharedRules;
 const found=Object.values(QUESTION_DATABASE).flat().find(q=>q.id===question.id);
 assert.ok(found,'Assigned quiz must exist in the shared rule database');return found.correct;
}
function skillFor(player){const {HERO_CLASSES}=sharedRules;return HERO_CLASSES[player.classKey??'enzym'].skills[0];}
function movePayload(state,player,question,answer,skill=skillFor(player)){
 return {type:'skill',skillId:skill.id,targetId:state.battle.enemies[0].id,allyId:player.id,battleId:state.battle.id,turnNumber:state.battle.turnNumber,quizId:question.id,answer};
}

test('two players share one squad while sessions and invitation credentials stay private',async t=>{
 const f=await fixture(t),host=await create(f),invite=await invitation(f,host),guest=await join(f,host,'Guest',invite);
 const hostView=accepted(await f.read(host)),guestView=accepted(await f.read(guest));
 assert.deepEqual(hostView.state,guestView.state);assert.equal(Object.keys(hostView.state.members).length,2);
 assertNoCredentials(hostView,[host.token,guest.token,invite]);assertNoCredentials(guestView,[host.token,guest.token,invite]);
 rejected(await f.request('GET','/api/squads/'+host.code));
 rejected(await f.request('GET','/api/squads/'+host.code,undefined,token()));
 rejected(await f.request('POST','/api/squads/'+host.code+'/command',{command:'class',payload:{classKey:'enzym'},requestId:randomUUID()}));
 rejected(await f.request('POST','/api/squads/'+host.code+'/join',{name:'Intruder',invite:token(),sessionToken:token()}));
 rejected(await f.request('POST','/api/squads/'+host.code+'/invite',{requestId:randomUUID()},guest.token));
 assert.deepEqual(accepted(await f.read(host)).state,hostView.state);
});

test('squads cap membership at four',async t=>{
 const f=await fixture(t),host=await create(f),invite=await invitation(f,host);
 const guests=[];for(let i=0;i<3;i++)guests.push(await join(f,host,'Guest '+i,invite));
 const before=accepted(await f.read(host)).state;
 rejected(await f.request('POST','/api/squads/'+host.code+'/join',{name:'Fifth player',invite,sessionToken:token()}));
 assert.deepEqual(accepted(await f.read(host)).state,before);assert.equal(Object.keys(before.members).length,4);
});

test('classes are unique, readiness is required and only the host starts combat',async t=>{
 const f=await fixture(t),{host,guest}=await pair(f);
 accepted(await f.command(host,'class',{classKey:'enzym'}));
 rejected(await f.command(guest,'class',{classKey:'enzym'}));
 assert.equal(accepted(await f.read(guest)).state.members[guest.id].classKey,null);
 accepted(await f.command(guest,'class',{classKey:'macrofaag'}));
 rejected(await f.command(host,'start'));assert.equal(accepted(await f.read(host)).state.status,'lobby');
 accepted(await f.command(host,'ready',{ready:true}));accepted(await f.command(guest,'ready',{ready:true}));
 rejected(await f.command(guest,'start'));assert.equal(accepted(await f.read(host)).state.status,'lobby');
 const invite=await invitation(f,host);
 const started=accepted(await f.command(host,'start')).state;assert.equal(started.status,'battle');
 rejected(await f.request('POST','/api/squads/'+host.code+'/join',{name:'Late guest',invite,sessionToken:token()}));
});

test('concurrent retries buy once and both players observe the resulting inventory',async t=>{
 const f=await fixture(t),{host,guest}=await pair(f);await chooseClasses(f,host,guest);
 const before=accepted(await f.read(host)).state.members[host.id].inventory;
 const requestId=randomUUID(),responses=await Promise.all([f.command(host,'buy',{itemId:'lipid'},requestId),f.command(host,'buy',{itemId:'lipid'},requestId)]);
 responses.forEach(accepted);
 accepted(await f.command(host,'buy',{itemId:'lipid'},requestId));
 const state=accepted(await f.read(guest)).state;
 assert.equal(state.members[host.id].inventory.coins,before.coins-8);
 assert.equal(state.members[host.id].inventory.materials.lipid,before.materials.lipid+1);
 assert.equal(state.members[guest.id].inventory.coins,40);
 const unchanged=clone(state);rejected(await f.command(host,'buy',{itemId:'nucleus'}));
 assert.deepEqual(accepted(await f.read(guest)).state,unchanged);
});

test('quests require progress and each player can claim a shared objective once',async t=>{
 const f=await fixture(t),{host,guest}=await pair(f);await chooseClasses(f,host,guest);
 const initial=accepted(await f.read(host)).state;
 rejected(await f.command(host,'claim-quest',{questId:'first-hunt'}));
 assert.deepEqual(accepted(await f.read(host)).state,initial);
 await f.app.store.update(host.code,record=>{(record.state??record).teamKills=3;});
 accepted(await f.command(host,'claim-quest',{questId:'first-hunt'}));
 accepted(await f.command(guest,'claim-quest',{questId:'first-hunt'}));
 const state=accepted(await f.read(host)).state;
 for(const player of [host,guest]){
  const inv=state.members[player.id].inventory;assert.equal(inv.coins,70);assert.equal(inv.materials.protein,2);assert.equal(inv.items.health,1);assert.deepEqual(inv.quests,['first-hunt']);
 }
 rejected(await f.command(host,'claim-quest',{questId:'first-hunt'}));
 assert.deepEqual(accepted(await f.read(guest)).state,state);
});

test('crafted armor, equipment and rejected payloads keep authoritative state consistent',async t=>{
 const f=await fixture(t),{host,guest}=await pair(f);await chooseClasses(f,host,guest);
 await f.app.store.update(host.code,record=>{const inv=(record.state??record).members[host.id].inventory;inv.materials.lipid=3;inv.materials.protein=2;});
 accepted(await f.command(host,'craft',{recipeId:'membrane-1'}));
 let state=accepted(await f.read(guest)).state,m=state.members[host.id];
 assert.equal(m.inventory.materials.lipid,0);assert.equal(m.inventory.materials.protein,0);assert.ok(m.inventory.gear.includes('membrane-1'));assert.equal(m.equipment.armor,'membrane-1');
 accepted(await f.command(host,'equip',{slot:'armor',gearId:null}));
 assert.equal(accepted(await f.read(guest)).state.members[host.id].equipment.armor,null);
 accepted(await f.command(host,'equip',{slot:'armor',gearId:'membrane-1'}));
 state=accepted(await f.read(host)).state;
 for(const [command,payload] of [['equip',{slot:'armor',gearId:'membrane-3'}],['attribute',{key:'kracht',count:-1}],['ready',{ready:'yes'}],['class',{classKey:'__proto__'}],['buy',{itemId:'__proto__'}]]){
  rejected(await f.command(host,command,payload));assert.deepEqual(accepted(await f.read(guest)).state,state);
 }
});

test('failed skills consume mana, provide a membrane shield and remain off cooldown',async t=>{
 const f=await fixture(t),{host,guest}=await pair(f);await startBattle(f,host,guest);
 const state=await arrangeTurn(f,host),question=await quiz(f,host,state),correct=answerFor(question),skill=skillFor(host);
 const failed=accepted(await f.command(host,'action',movePayload(state,host,question,(correct+1)%question.options.length))).state;
 const m=failed.members[host.id];assert.equal(m.atp,200-skill.cost+12);assert.equal(m.shield,true);assert.equal(m.skillCooldowns[skill.id]??0,0);assert.equal(failed.battle.enemies[0].hp,1000);
 const observed=accepted(await f.read(guest)).state;assert.equal(observed.members[host.id].shield,true);assert.equal(observed.members[host.id].atp,m.atp);
 const again=await arrangeTurn(f,host),nextQuestion=await quiz(f,host,again);
 const succeeded=accepted(await f.command(host,'action',movePayload(again,host,nextQuestion,answerFor(nextQuestion)))).state;
 assert.equal(succeeded.battle.enemies[0].hp,1000-skill.power);assert.equal(succeeded.members[host.id].skillCooldowns[skill.id],again.battle.round+skill.cooldown+1);
});

test('successful skills deal full damage, apply cooldown and reject replayed turns',async t=>{
 const f=await fixture(t),{host,guest}=await pair(f);await startBattle(f,host,guest);
 const state=await arrangeTurn(f,host),question=await quiz(f,host,state),skill=skillFor(host),payload=movePayload(state,host,question,answerFor(question));
 const requestId=randomUUID(),result=accepted(await f.command(host,'action',payload,requestId)).state;
 assert.equal(result.members[host.id].atp,200-skill.cost+12);assert.equal(result.battle.enemies[0].hp,1000-skill.power);
 assert.equal(result.members[host.id].skillCooldowns[skill.id],state.battle.round+skill.cooldown+1);
 accepted(await f.command(host,'action',payload,requestId));assert.deepEqual(accepted(await f.read(guest)).state,result);
 rejected(await f.command(host,'action',payload));assert.deepEqual(accepted(await f.read(guest)).state,result);
 const next=await arrangeTurn(f,host,2),nextQuestion=await quiz(f,host,next),before=accepted(await f.read(host)).state;
 rejected(await f.command(host,'action',movePayload(next,host,nextQuestion,answerFor(nextQuestion))));
 assert.deepEqual(accepted(await f.read(guest)).state,before);
});

test('server assigns combat quizzes and rejects forged questions, invalid answers and wrong turns',async t=>{
 const f=await fixture(t),{host,guest}=await pair(f);await startBattle(f,host,guest);
 const state=await arrangeTurn(f,host),skill=skillFor(host);
 const arbitrary={id:'not-a-question',options:['a','b']};
 rejected(await f.command(host,'action',movePayload(state,host,arbitrary,0,skill)));
 rejected(await f.request('POST','/api/squads/'+guest.code+'/quiz',{battleId:state.battle.id,turnNumber:state.battle.turnNumber},guest.token));
 const question=await quiz(f,host,state),before=accepted(await f.read(host)).state;
 const repeatQuestion=await quiz(f,host,state);assert.equal(repeatQuestion.id,question.id);
 for(const payload of [movePayload(state,host,{...question,id:'not-a-question'},0),movePayload(state,host,question,99),{...movePayload(state,host,question,answerFor(question)),turnNumber:state.battle.turnNumber-1}]){
  rejected(await f.command(host,'action',payload));assert.deepEqual(accepted(await f.read(guest)).state,before);
 }
 rejected(await f.command(guest,'action',movePayload(state,guest,question,answerFor(question))));
 assert.deepEqual(accepted(await f.read(host)).state,before);
});

test('squad progress and sessions survive a server restart, including request deduplication',async t=>{
 const f=await fixture(t),{host,guest}=await pair(f);await chooseClasses(f,host,guest);
 const requestId=randomUUID();accepted(await f.command(host,'buy',{itemId:'lipid'},requestId));
 const before=accepted(await f.read(guest)).state;
 await f.app.close();f.app=createGameServer({dataDir:f.dataDir,port:0,tickIntervalMs:250});await f.app.listen();
 assert.deepEqual(accepted(await f.read(host)).state,before);assert.deepEqual(accepted(await f.read(guest)).state,before);
 accepted(await f.command(host,'buy',{itemId:'lipid'},requestId));assert.deepEqual(accepted(await f.read(guest)).state,before);
});

test('leaving transfers host authority and revokes the departing session',async t=>{
 const f=await fixture(t),{host,guest}=await pair(f);await chooseClasses(f,host,guest);
 const buyRequestId=randomUUID();accepted(await f.command(host,'buy',{itemId:'lipid'},buyRequestId));
 const oldInvitation=await invitation(f,host);
 const leaveRequestId=randomUUID(),left=accepted(await f.command(host,'leave',{},leaveRequestId));
 assert.equal(left.ok,true);assert.equal(Object.hasOwn(left,'state'),false);assert.equal(Object.hasOwn(left,'playerId'),false);
 const leaveRetry=accepted(await f.command(host,'leave',{},leaveRequestId));assert.equal(leaveRetry.ok,true);assert.equal(Object.hasOwn(leaveRetry,'state'),false);assert.equal(Object.hasOwn(leaveRetry,'playerId'),false);
 const remaining=accepted(await f.read(guest));assert.equal(remaining.host,true);assert.equal(remaining.state.hostId,guest.id);assert.equal(remaining.state.members[host.id],undefined);
 rejected(await f.read(host));rejected(await f.command(host,'buy',{itemId:'lipid'}));
 const oldReceipt=await f.command(host,'buy',{itemId:'lipid'},buyRequestId);assert.equal(oldReceipt.status,403);assert.equal(Object.hasOwn(oldReceipt.data,'state'),false);
 rejected(await f.request('POST','/api/squads/'+host.code+'/join',{name:'Old invitation user',invite:oldInvitation,sessionToken:token()}));
 const invited=await invitation(f,guest);assert.match(invited,/^[a-f0-9]{64}$/i);
 accepted(await f.command(guest,'ready',{ready:true}));assert.equal(accepted(await f.command(guest,'start')).state.status,'battle');
});

test('a failed skill shield halves one enemy attack and is then consumed',async t=>{
 let clock=Date.now();const f=await fixture(t,{now:()=>clock}),{host,guest}=await pair(f);await startBattle(f,host,guest);
 const state=await arrangeTurn(f,host),question=await quiz(f,host,state),correct=answerFor(question);
 accepted(await f.command(host,'action',movePayload(state,host,question,(correct+1)%question.options.length)));
 function enemyTurn(record){
  const b=record.state.battle,enemy=b.enemies[0];b.activeActorId=enemy.id;b.activePlayerId=null;b.phase='enemy';b.turnIndex=b.turnQueue.indexOf(enemy.id);b.deadline=clock-1;b.tauntPlayerId=host.id;
 }
 await f.app.store.update(host.code,enemyTurn);
 let observed=accepted(await f.read(guest)).state;
 const shieldedHit=observed.battle.events.at(-1).targets.find(target=>target.id===host.id);
 assert.ok(shieldedHit);assert.ok(shieldedHit.amount>=10&&shieldedHit.amount<=11);assert.equal(observed.members[host.id].shield,false);
 const hp=observed.members[host.id].hp;
 await f.app.store.update(host.code,enemyTurn);
 observed=accepted(await f.read(guest)).state;
 const unshieldedHit=observed.battle.events.at(-1).targets.find(target=>target.id===host.id);
 assert.ok(unshieldedHit.amount>=20&&unshieldedHit.amount<=22);assert.equal(observed.members[host.id].hp,hp-unshieldedHit.amount);
});

test('submitting a quiz timeout turns a skill into mana loss and a shield',async t=>{
 const f=await fixture(t),{host,guest}=await pair(f);await startBattle(f,host,guest);
 const state=await arrangeTurn(f,host);
 const assignment=accepted(await f.request('POST','/api/squads/'+host.code+'/quiz',{battleId:state.battle.id,turnNumber:state.battle.turnNumber},host.token));
 const skill=skillFor(host),result=accepted(await f.command(host,'action',movePayload(state,host,assignment.question,-1))).state;
 assert.equal(result.members[host.id].atp,200-skill.cost+12);assert.equal(result.members[host.id].shield,true);assert.equal(result.members[host.id].skillCooldowns[skill.id]??0,0);assert.equal(result.battle.enemies[0].hp,1000);
});

test('combat loot reaches both inventories and a stage leads into a shared route vote',async t=>{
 const f=await fixture(t),{host,guest}=await pair(f);await startBattle(f,host,guest);await arrangeTurn(f,host);
 await f.app.store.update(host.code,record=>{
  const b=record.state.battle;b.enemies.forEach((enemy,index)=>{enemy.hp=index===0?1:0;});b.enemyHp=1;
 });
 const state=accepted(await f.read(host)).state,question=await quiz(f,host,state),payload=movePayload(state,host,question,answerFor(question));payload.type='attack';delete payload.skillId;
 const won=accepted(await f.command(host,'action',payload)).state;
 assert.equal(won.status,'lobby');assert.equal(won.battle.result,'victory');assert.equal(won.stageIndex,1);assert.equal(won.teamKills,1);
 for(const player of [host,guest]){assert.equal(won.members[player.id].inventory.coins,50);assert.ok(won.members[player.id].xp>=55);}
 assert.deepEqual(won.members[host.id].inventory.materials,won.members[guest.id].inventory.materials);
 assert.equal(won.journey.status,'voting');const depot=won.journey.options.find(option=>option.effect==='supplies');assert.ok(depot);
 rejected(await f.command(host,'ready',{ready:true}));
 accepted(await f.command(host,'vote',{journeyId:won.journey.id,optionId:depot.id}));
 assert.equal(accepted(await f.read(guest)).state.journey.status,'voting');
 const resolved=accepted(await f.command(guest,'vote',{journeyId:won.journey.id,optionId:depot.id})).state;assert.equal(resolved.journey.status,'resolved');
 for(const player of [host,guest])for(const material of ['lipid','protein','mineral'])assert.equal(resolved.members[player.id].inventory.materials[material],won.members[player.id].inventory.materials[material]+3);
 accepted(await f.command(host,'ready',{ready:true}));accepted(await f.command(guest,'ready',{ready:true}));assert.equal(accepted(await f.command(host,'start')).state.stageIndex,1);
});
