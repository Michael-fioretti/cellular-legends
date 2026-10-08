const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const rules=html.slice(html.indexOf('const questionRows='),html.indexOf('        /* GAME STATE */'));
function setup(classKey='enzym'){
 const c=vm.createContext({crypto:require('node:crypto').webcrypto,localStorage:{setItem(){}}});
 vm.runInContext(rules+';globalThis.api={makeMember,SquadEngine,performCombatAction,skillCooldownRemaining,HERO_CLASSES,QUESTION_DATABASE};',c);
 const a=c.api,m=a.makeMember('solo','Test');m.classKey=classKey;m.level=5;m.maxAtp=m.atp=200;
 const s={code:'SOLO',hostId:'solo',rulesVersion:2,status:'battle',stageIndex:0,members:{solo:m},teamKills:0,teamXp:0,pointsAwarded:0,battle:{id:'battle',level:1,round:1,turnNumber:0,phase:'player',activePlayerId:'solo',activeActorId:'solo',initiative:[],turnQueue:['solo','enemy-0'],turnIndex:0,enemies:[{id:'enemy-0',name:'Enemy',hp:1000,maxHp:1000,damage:20}],log:[],events:[],eventSeq:0}};
 const engine=new a.SquadEngine(s),q=a.QUESTION_DATABASE.easy[0];m.questionMode='easy';
 const skill=a.HERO_CLASSES[classKey].skills[0];
 const payload={type:'skill',skillId:skill.id,targetId:'enemy-0',allyId:'solo',quizId:q.id,answer:q.correct};
 return {a,m,s,engine,q,skill,payload};
}
test('successful skill consumes full ATP, deals full damage and blocks the next complete round',()=>{
 const {a,m,s,skill,payload}=setup();a.performCombatAction(s,'solo',payload);
 assert.equal(m.atp,200-skill.cost);assert.equal(s.battle.enemies[0].hp,1000-skill.power);assert.equal(m.shield,false);
 const after=m.atp;assert.throws(()=>a.performCombatAction(s,'solo',payload),/cooldown/);assert.equal(m.atp,after);
 s.battle.round=2;assert.equal(a.skillCooldownRemaining(m,skill,s.battle),1);assert.throws(()=>a.performCombatAction(s,'solo',payload),/cooldown/);
 s.battle.round=3;assert.equal(a.skillCooldownRemaining(m,skill,s.battle),0);a.performCombatAction(s,'solo',payload);assert.equal(m.atp,200-2*skill.cost);
});
for(const answer of ['wrong','timeout'])test(answer+' skill spends ATP, gives shield, deals no damage and remains reusable',()=>{
 const {a,m,s,skill,payload,q}=setup();payload.answer=answer==='timeout'?-1:(q.correct+1)%q.options.length;
 a.performCombatAction(s,'solo',payload);assert.equal(m.atp,200-skill.cost);assert.equal(s.battle.enemies[0].hp,1000);assert.equal(m.shield,true);assert.equal(a.skillCooldownRemaining(m,skill,s.battle),0);
 payload.answer=q.correct;a.performCombatAction(s,'solo',payload);assert.equal(m.atp,200-2*skill.cost);assert.equal(s.battle.enemies[0].hp,1000-skill.power);
});
test('failed skill shield halves the next incoming attack and is consumed',()=>{
 const {a,m,s,engine,payload,q}=setup();m.hp=m.maxHp=200;payload.answer=(q.correct+1)%q.options.length;a.performCombatAction(s,'solo',payload);
 s.battle.activeActorId='enemy-0';s.battle.turnIndex=1;engine.enemyTurn();assert.ok(200-m.hp>=10&&200-m.hp<=11);assert.equal(m.shield,false);
});
test('stronger moves wait longer; cooldowns are isolated by move, player and battle',()=>{
 const {a,m,s,engine,payload}=setup();const strong=a.HERO_CLASSES.enzym.skills[3];payload.skillId=strong.id;a.performCombatAction(s,'solo',payload);
 assert.equal(strong.cooldown,3);s.battle.round=2;assert.equal(a.skillCooldownRemaining(m,strong,s.battle),3);
 assert.equal(a.skillCooldownRemaining(m,a.HERO_CLASSES.enzym.skills[0],s.battle),0);
 const other=a.makeMember('other','Other');assert.equal(a.skillCooldownRemaining(other,strong,s.battle),0);
 for(let r=3;r<=4;r++){s.battle.round=r;assert.ok(a.skillCooldownRemaining(m,strong,s.battle)>0);}s.battle.round=5;assert.equal(a.skillCooldownRemaining(m,strong,s.battle),0);
 s.status='lobby';m.isReady=true;engine.command('solo','start');assert.equal(Object.keys(m.skillCooldowns).length,0);
});
test('unsuccessful healing provides only self shield; basic attacks remain cooldown-free',()=>{
 const {a,m,s,payload,q}=setup('ribosoom');m.hp=1;payload.answer=(q.correct+1)%q.options.length;a.performCombatAction(s,'solo',payload);assert.equal(m.hp,1);assert.equal(m.shield,true);
 payload.type='attack';payload.answer=q.correct;const atp=m.atp;a.performCombatAction(s,'solo',payload);a.performCombatAction(s,'solo',payload);assert.equal(m.atp,atp);assert.equal(Object.keys(m.skillCooldowns).length,0);
});
test('invalid quiz and insufficient ATP have no side effects; engine preserves normal turn regeneration',()=>{
 const {a,m,s,engine,payload}=setup();m.atp=1;assert.throws(()=>a.performCombatAction(s,'solo',payload),/weinig ATP/);assert.equal(m.shield,false);m.atp=200;
 assert.throws(()=>a.performCombatAction(s,'solo',{...payload,quizId:'bad'}),/vraag/);assert.equal(m.atp,200);
 engine.command('solo','action',{...payload,answer:-1,turnNumber:0,battleId:'battle'});assert.equal(m.atp,200-25+12);assert.equal(m.shield,true);
});
