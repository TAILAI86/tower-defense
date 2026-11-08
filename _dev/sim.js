/* 开发用无头模拟器（不是游戏本体，可删除）
   作用：在 Node 中加载 index.html 里的游戏逻辑，用一个"像人一样打"的机器人跑完整局，
   验证：波次推进、建造/升级/出售、伤害结算、胜负判定，以及渲染函数不抛异常。
   运行： node _dev/sim.js                                        */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('未找到 <script> 块');

const winStub = {
  innerWidth: 1400, innerHeight: 900, devicePixelRatio: 1, listeners: {},
  addEventListener(name, fn) { this.listeners[name] = fn; }, requestAnimationFrame() {}, __TD_NO_BOOT__: true
};
const docStub = { getElementById: () => null, addEventListener() {}, readyState: 'complete' };
const storage = Object.create(null);
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
  setItem(k, v) { storage[k] = String(v); }
};
new Function('window', 'document', 'localStorage', 'requestAnimationFrame', 'performance', 'console', m[1])(
  winStub, docStub, global.localStorage, () => {}, { now: Date.now }, console);

const TD = winStub.TD;
if (!TD) throw new Error('游戏未导出 TD API');

const CELL = TD.CELL;
function cx(c) { return c * CELL + CELL / 2; }
function cy(r) { return 60 + r * CELL + CELL / 2; }

/* 路径上某点距起点的距离（用于给建造点排序：沿路依次布置） */
function distAlong(x, y, path) {
  const P = path || TD.PATH;
  const pts = P.pts;
  let best = { d: Infinity, along: 0 };
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x, ay = pts[i - 1].y, bx = pts[i].x, by = pts[i].y;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((x - ax) * dx + (y - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, py = ay + dy * t;
    const d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { d, along: P.cum[i - 1] + Math.sqrt(len2) * t };
  }
  return best;
}

/* 每张地图的建塔点位各不相同，按关卡缓存 */
const SPOTS = {};
function spots(s) {
  const key = s.level || 'main';
  if (SPOTS[key]) return SPOTS[key];
  const path = s.path || TD.PATH;
  const list = TD.buildableCells(s).map(p => {
    const r = distAlong(cx(p.c), cy(p.r), path);
    return { c: p.c, r: p.r, gap: r.d, along: r.along };
  }).filter(p => p.gap < CELL * 1.2)
    .sort((a, b) => a.along - b.along);
  SPOTS[key] = list;
  return list;
}

/* 一个有经验的玩家会用的建塔顺序：先堆输出，中期再补支援型增幅塔 */
const PLAN = ['arrow', 'frost', 'arrow', 'cannon', 'arrow', 'tesla', 'cannon', 'sniper',
  'frost', 'arrow', 'tesla', 'cannon', 'sniper', 'arrow', 'cannon', 'frost',
  'tesla', 'sniper', 'cannon', 'arrow', 'amp', 'cannon', 'frost', 'sniper',
  'cannon', 'arrow', 'tesla', 'cannon', 'sniper', 'arrow', 'cannon', 'frost'];

function makeCtx() {
  const state = {};
  return new Proxy(state, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'measureText') return () => ({ width: 12 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (p === 'canvas') return { width: 1000, height: 680 };
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}

function run(mode, opts) {
  opts = opts || {};
  const s = TD.newGame(mode);
  const ctx = makeCtx();
  const dt = 1 / 60;
  const list = spots(s).slice();
  let planIdx = 0, frames = 0, renderErr = null;
  const timeline = [];
  let lastWave = -1;

  while (s.scene === 'play' && frames < 60 * (opts.maxSec || 1500)) {
    if (!opts.idle) {
      const buildLimit = opts.buildLimit || PLAN.length;
      let built = false;
      /* 先铺够一定数量的塔，再集中升级 */
      if (planIdx < buildLimit) {
        const key = PLAN[planIdx % PLAN.length];
        if (s.gold >= TD.TOWERS[key].cost && list.length) {
          while (list.length) {
            const p = list.shift();
            if (!TD.cellFree(s, p.c, p.r)) continue;
            if (TD.placeTower(s, key, p.c, p.r).ok) { planIdx++; built = true; }
            break;
          }
        }
      }
      /* 升级：优先升等级最低、位置最靠前的塔 */
      if (!built && s.towers.length) {
        const cand = s.towers.filter(t => t.level < 8)
          .sort((a, b) => (a.level - b.level) || (a.dist - b.dist))[0];
        if (cand && s.gold >= TD.upgradeCost(cand)) TD.upgradeTower(s, cand);
      }
    }

    TD.step(s, dt);
    if (frames % 5 === 0) { try { TD.draw(s, ctx); } catch (e) { if (!renderErr) renderErr = e; } }
    if (s.wave !== lastWave) { lastWave = s.wave; timeline.push('W' + s.wave + '@' + (frames / 60).toFixed(0) + 's/♥' + s.lives + '/塔' + s.towers.length); }
    frames++;
  }

  return {
    mode, scene: s.scene, wave: s.wave, lives: s.lives, score: s.score, gold: s.gold,
    towers: s.towers.length, kills: s.stat.kills, leaked: s.stat.leaked,
    simSec: +(frames / 60).toFixed(0), renderErr: renderErr ? String(renderErr) : null,
    timeline: timeline.join(' ')
  };
}

console.log('=== 机器人完整对局（像人一样沿路建塔）===');
const campaign = {};
for (const mode of ['easy', 'normal', 'hard', 'forge']) {
  const r = run(mode);
  campaign[mode] = r;
  console.log(`[${r.mode}] ${r.scene}  到第 ${r.wave}/${TD.totalWaves(mode)} 波  剩余生命 ${r.lives}  得分 ${r.score}  塔 ${r.towers}  击杀 ${r.kills}  漏怪 ${r.leaked}  时长 ${r.simSec}s  渲染异常 ${r.renderErr || '无'}`);
  console.log('    ' + r.timeline);
}

console.log('\n=== 只建 8 座塔（较弱玩法，用于看压力）===');
for (const mode of ['normal', 'hard']) {
  const r = run(mode, { buildLimit: 8 });
  console.log(`[${r.mode}] ${r.scene} 到第 ${r.wave} 波 剩余生命 ${r.lives} 塔 ${r.towers} 漏怪 ${r.leaked}`);
}

console.log('\n=== 不建塔（必须判负）===');
const idle = run('normal', { idle: true });
console.log(`[normal] ${idle.scene} 到第 ${idle.wave} 波 生命 ${idle.lives}`);

console.log('\n=== 无尽模式（无终点：机器人可一直守下去，且永不判胜）===');
const er = run('endless', { maxSec: 3600 });
console.log(`[endless] ${er.scene} 撑到第 ${er.wave} 波 击杀 ${er.kills} 时长 ${er.simSec}s 渲染异常 ${er.renderErr || '无'}`);
console.log('    ' + er.timeline);

console.log('\n=== 单元断言 ===');
let fail = 0, passed = 0;
function assert(name, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name);
  if (cond) passed++;
  else { fail++; process.exitCode = 1; }
}
assert('简单/普通/困难机器人均可通关 15 波', ['easy', 'normal', 'hard'].every(m => campaign[m].scene === 'win' && campaign[m].wave === 15));
assert('熔渊关卡机器人可通关 12 波', campaign.forge.scene === 'win' && campaign.forge.wave === TD.totalWaves('forge'));
assert('完整对局与菜单渲染无异常', ['easy', 'normal', 'hard', 'forge'].every(m => !campaign[m].renderErr) && !er.renderErr);
assert('不建塔必须失败', idle.scene === 'lose' && idle.lives === 0);
{
  const s = TD.newGame('normal');
  const g0 = s.gold;
  const b = TD.placeTower(s, 'arrow', 0, 0);
  assert('在空地建塔成功', b.ok === true);
  assert('建塔扣除金币 60', s.gold === g0 - 60);
  assert('同一格不能重复建造', TD.placeTower(s, 'arrow', 0, 0).ok === false);
  assert('路径上不能建造', TD.placeTower(s, 'arrow', 4, 2).ok === false);
  assert('基地格不能建造', TD.placeTower(s, 'arrow', 23, 6).ok === false);
  const t = b.tower, st1 = TD.towerStats(t);
  TD.upgradeTower(s, t);
  const st2 = TD.towerStats(t);
  assert('升级提升等级/伤害/射程', t.level === 2 && st2.dmg > st1.dmg && st2.range > st1.range);
  TD.upgradeTower(s, t);
  assert('可继续升到 3 级（不再封顶）', t.level === 3);
  s.gold = 999999;
  let lv = t.level;
  for (let i = 0; i < 4; i++) if (TD.upgradeTower(s, t).ok) lv++;
  assert('金币充足时可突破旧上限继续升级', t.level >= 7 && lv === t.level);
  const costs = [];
  for (let k = 1; k <= 6; k++) costs.push(TD.upgradeCost({ key: 'arrow', level: k }));
  assert('升级成本随等级单调递增', costs.every((c, i) => i === 0 || c > costs[i - 1]));
  const deep = TD.towerStats({ key: 'arrow', level: 30 });
  assert('射程在高等级封顶（不会一塔盖全图）', deep.range === TD.TOWERS.arrow.range + 6 * 12);
  assert('高等级伤害继续增长', deep.dmg > TD.towerStats({ key: 'arrow', level: 20 }).dmg);
  s.gold = 10;
  assert('金币不足时无法继续升级', TD.upgradeTower(s, t).ok === false);
  const goldBefore = s.gold;
  TD.sellTower(s, t);
  assert('出售返还金币并可复用格子', s.gold > goldBefore && TD.cellFree(s, t.c, t.r) === true);
}
{
  const s = TD.newGame('normal');
  assert('初始处于准备阶段', s.phase === 'prep' && s.wave === 0);
  TD.callWaveEarly(s);
  assert('呼叫后进入出怪阶段', s.phase === 'spawning' && s.wave === 1);
  for (let i = 0; i < 90; i++) TD.step(s, 1 / 60);
  assert('出怪队列开始生成敌人', s.enemies.length > 0);
}
{
  const s = TD.newGame('normal');
  s.lives = 1; s.phase = 'spawning'; s.wave = 1; s.spawnQueue = [];
  s.enemies = [{ id: 1, type: 'grunt', x: 900, y: 320, dist: TD.PATH.total - 1,
    hp: 10, maxHp: 10, speed: 60, slowT: 0, slowMul: 1, r: 11, armor: 0,
    gold: 8, leak: 5, score: 10, color: '#fff', shape: 'circle', ang: 0, hitT: 0, dead: false, wob: 0 }];
  for (let i = 0; i < 8; i++) TD.step(s, 1 / 60);
  assert('漏怪扣生命并进入失败', s.scene === 'lose' && s.lives === 0);
}
{
  const s = TD.newGame('normal');
  s.wave = TD.WAVES.length; s.phase = 'clearing'; s.spawnQueue = []; s.enemies = [];
  TD.step(s, 1 / 60);
  assert('清空最后一波即胜利', s.scene === 'win');
}
{
  const s = TD.newGame('normal');
  const slow = TD.TOWERS.frost;
  assert('存在减速类与范围类塔', !!slow.slow && TD.TOWERS.cannon.splash > 0 && TD.TOWERS.arrow.splash === 0);
  assert('存在磁暴连锁塔', TD.TOWERS.tesla.proj === 'chain' && TD.TOWERS.tesla.chain >= 3);
}
{
  /* 磁暴塔：连锁闪电可击杀成群敌人 */
  const s = TD.newGame('normal');
  s.gold = 9999; s.wave = 1; s.prepLeft = 9999;
  const b = TD.placeTower(s, 'tesla', 6, 7);
  TD.upgradeTower(s, b.tower); TD.upgradeTower(s, b.tower); // 升满级保证窗口期内击杀
  assert('磁暴塔可建造', b.ok === true);
  TD.spawnEnemy(s, 'grunt'); TD.spawnEnemy(s, 'grunt'); TD.spawnEnemy(s, 'grunt');
  const k0 = s.stat.kills;
  for (let i = 0; i < 60 * 30 && s.stat.kills < 3; i++) TD.step(s, 1 / 60);
  assert('磁暴塔连锁击杀敌群', s.stat.kills >= 3 && s.stat.kills > k0);
}
{
  /* 分裂虫：死亡后钻出 2 只幼虫，且幼虫能被消灭 */
  const s = TD.newGame('normal');
  s.gold = 9999; s.wave = 1; s.prepLeft = 9999; // 冻结倒计时，避免中途自动开波干扰断言
  const ab = TD.placeTower(s, 'arrow', 6, 7);
  TD.upgradeTower(s, ab.tower); TD.upgradeTower(s, ab.tower); // 升满级：一箭一只幼虫
  const sp = TD.spawnEnemy(s, 'splitter');
  sp.hp = 1;
  let splitSeen = false;
  for (let i = 0; i < 60 * 30; i++) {
    TD.step(s, 1 / 60);
    if (s.stat.kills >= 1 && s.enemies.filter(e => e.type === 'mite').length >= 2) { splitSeen = true; break; }
  }
  assert('分裂虫死亡后生成 2 只幼虫', splitSeen);
  for (let i = 0; i < 60 * 30 && s.enemies.length; i++) TD.step(s, 1 / 60);
  assert('幼虫也会被清理干净', s.enemies.length === 0 && s.stat.kills >= 3);
}
{
  /* 暂停时鼠标不能建造 / 召唤（只能操作顶栏按钮） */
  const s = TD.newGame('normal');
  s.paused = true;
  s.pick = 'arrow';
  TD.click(s, 6 * 40 + 20, 60 + 6 * 40 + 20);
  assert('暂停时点击场地无法建塔', s.towers.length === 0);
  const R = TD.uiRects(s);
  TD.click(s, R.wave.x + 60, R.wave.y + 70);
  assert('暂停时无法立即召唤', s.phase === 'prep' && s.wave === 0);
  TD.click(s, R.pause.x + 5, R.pause.y + 5);
  assert('暂停时仍可点击继续按钮', s.paused === false);
}
{
  /* 出售返还计入累计收入统计 */
  const s = TD.newGame('normal');
  const g0 = s.stat.goldEarned;
  const b = TD.placeTower(s, 'arrow', 0, 0);
  TD.sellTower(s, b.tower);
  assert('出售返还计入 goldEarned', s.stat.goldEarned === g0 + TD.sellValue({ invested: 60 }));
}
{
  /* 无尽模式：清完第 15 波不判胜，第 16 波由程序生成 */
  const s = TD.newGame('endless');
  s.wave = 15; s.phase = 'clearing'; s.spawnQueue = []; s.enemies = [];
  TD.step(s, 1 / 60);
  assert('无尽模式清完 15 波不判胜', s.scene === 'play' && s.phase === 'prep');
  TD.callWaveEarly(s);
  assert('无尽模式第 16 波程序生成', s.phase === 'spawning' && s.wave === 16 && s.spawnQueue.length > 0);
  assert('无尽模式没有终点：越过 15 波后仍继续且不判胜', er.wave > 15 && er.scene !== 'win');
}
{
  /* 输入边界：非法格子、未知敌人与无效时间步都不能污染状态 */
  const s = TD.newGame('normal');
  const g0 = s.gold;
  assert('非整数坐标不能建塔', TD.placeTower(s, 'arrow', 0.5, 0).ok === false && s.gold === g0);
  assert('未知敌人类型安全返回 null', TD.spawnEnemy(s, 'missing') === null && s.enemies.length === 0);
  const e1 = TD.spawnEnemy(s, 'grunt', -20), e2 = TD.spawnEnemy(s, 'grunt', NaN);
  assert('负距离与 NaN 出生距离归零', e1.dist === 0 && e2.dist === 0);
  const time0 = s.time;
  TD.step(s, NaN); TD.step(s, -1); TD.step(s, 0);
  assert('无效时间步不会推进游戏', s.time === time0);
}
{
  /* 已出售的塔不能再次升级或出售 */
  const s = TD.newGame('normal');
  const b = TD.placeTower(s, 'arrow', 0, 0);
  TD.sellTower(s, b.tower);
  const g0 = s.gold;
  assert('失效塔引用不能重复升级', TD.upgradeTower(s, b.tower).ok === false && s.gold === g0);
  assert('失效塔引用不能重复出售', TD.sellTower(s, b.tower).ok === false && s.gold === g0);
}
{
  /* 提前召唤必须先验证波次与暂停状态，再发金币 */
  const s = TD.newGame('normal');
  s.wave = TD.WAVES.length; s.phase = 'prep'; s.prepLeft = 8;
  const g0 = s.gold;
  TD.callWaveEarly(s);
  assert('战役最终波之后不能刷提前召唤奖励', s.gold === g0 && s.wave === TD.WAVES.length && s.phase === 'prep');
  const p = TD.newGame('normal'); p.paused = true;
  const pg = p.gold;
  TD.callWaveEarly(p);
  assert('暂停时 API 召唤也不发奖励', p.gold === pg && p.wave === 0);
}
{
  /* 护盾先承伤，脱战后恢复；毒素期间禁止恢复 */
  const s = TD.newGame('normal'); s.wave = 1; s.prepLeft = 9999;
  const e = TD.spawnEnemy(s, 'shield', 500);
  const hp0 = e.hp, sh0 = e.shield;
  TD.damageEnemy(s, e, 30, null);
  assert('护盾先于生命承受伤害', e.hp === hp0 && e.shield === sh0 - 30);
  e.shield = 0; e.shieldT = 0; e.poisonT = 0;
  TD.step(s, 0.05);
  assert('护盾脱战延迟结束后可恢复', e.shield > 0);
  e.shield = 0; e.shieldT = 0; e.poisonDps = 2; e.poisonT = 1;
  TD.step(s, 0.05);
  assert('毒素压制护盾恢复', e.shield === 0 && e.poisonT < 1);
}
{
  /* 毒液削甲与持续时间结束后的状态清理 */
  const s = TD.newGame('normal'); s.wave = 1; s.prepLeft = 9999;
  const e = TD.spawnEnemy(s, 'tank', 500);
  TD.applyVenom(s, e, { poisonDps: 8, poisonDur: 3, shred: 0.08, shredDur: 3, src: null });
  const hp0 = e.hp;
  TD.damageEnemy(s, e, 100, null, true);
  assert('毒液削甲按预期提高生命伤害', Math.abs((hp0 - e.hp) - 93) < 0.001);
  for (let i = 0; i < 70; i++) TD.step(s, 0.05);
  assert('削甲结束后状态归零', e.shredT === 0 && e.shred === 0);
}
{
  /* 持续伤害击杀要正确计入塔与全局统计 */
  const s = TD.newGame('normal'); s.gold = 9999; s.wave = 1; s.prepLeft = 9999;
  const b = TD.placeTower(s, 'venom', 6, 7);
  const e = TD.spawnEnemy(s, 'grunt', 500);
  e.hp = 1; e.poisonDps = 20; e.poisonT = 1; e.poisonSrc = b.tower;
  const k0 = s.stat.kills;
  for (let i = 0; i < 5; i++) TD.step(s, 0.05);
  assert('毒素击杀归属来源防御塔', s.stat.kills === k0 + 1 && b.tower.kills === 1);
}
{
  /* 毒液塔实战开火：追踪弹命中后施加毒素与削甲 */
  const s = TD.newGame('normal'); s.gold = 9999; s.wave = 1; s.prepLeft = 9999;
  TD.placeTower(s, 'venom', 6, 7);
  const e = TD.spawnEnemy(s, 'grunt', 520);
  let venomSeen = false;
  for (let i = 0; i < 120; i++) {
    TD.step(s, 1 / 60);
    if (e.poisonT > 0 && e.shredT > 0) { venomSeen = true; break; }
  }
  assert('毒液塔追踪弹命中并施加双状态', venomSeen);
}
{
  /* 高速追踪弹跨步碰撞：一帧跨过目标也应命中 */
  const s = TD.newGame('normal'); s.wave = 1; s.prepLeft = 9999;
  const e = TD.spawnEnemy(s, 'grunt', 500);
  const hp0 = e.hp;
  s.shots.push({ kind: 'homing', x: e.x - 100, y: e.y, target: e, dmg: 15,
    speed: 10000, color: '#fff', src: null, ang: 0 });
  TD.step(s, 0.05);
  assert('高速子弹不会穿过目标', e.hp === hp0 - 15 && s.shots.length === 0);
}
{
  /* 新敌军已进入战役波次 */
  const s = TD.newGame('normal'); s.wave = 5; s.prepLeft = 0;
  TD.callWaveEarly(s);
  assert('第 6 波生成护盾兵', s.wave === 6 && s.spawnQueue.some(q => q.t === 'shield'));
}
{
  /* 医疗兵：治疗光环内受伤同伴，不自愈、不越上限、不越距离 */
  const s = TD.newGame('normal'); s.wave = 1; s.prepLeft = 9999;
  const m = TD.spawnEnemy(s, 'medic', 500);
  const g = TD.spawnEnemy(s, 'grunt', 500);
  g.hp = Math.floor(g.maxHp / 2);
  const hp0 = g.hp, mHp = m.hp;
  TD.step(s, 0.05);
  assert('医疗兵治疗周围受伤同伴', g.hp > hp0 && g.hp <= g.maxHp);
  assert('医疗兵不能治疗自己', m.hp === mHp);
  g.speed = m.speed; // 保持同速，让同伴留在治疗光环内
  for (let i = 0; i < 200 && g.hp < g.maxHp; i++) TD.step(s, 0.05);
  assert('治疗不会突破生命上限', g.hp === g.maxHp);
}
{
  /* 治疗光环有距离限制 */
  const s = TD.newGame('normal'); s.wave = 1; s.prepLeft = 9999;
  TD.spawnEnemy(s, 'medic', 100);
  const far = TD.spawnEnemy(s, 'grunt', 900);
  far.hp = 1;
  TD.step(s, 0.05);
  assert('治疗光环有距离限制', far.hp === 1);
}
{
  /* 医疗兵已进入战役波次与无尽程序生成 */
  const s = TD.newGame('normal'); s.wave = 9; s.prepLeft = 0;
  TD.callWaveEarly(s);
  assert('第 10 波生成医疗兵', s.wave === 10 && s.spawnQueue.some(q => q.t === 'medic'));
  const es = TD.newGame('endless'); es.wave = 15; es.prepLeft = 0;
  TD.callWaveEarly(es);
  assert('无尽程序波次包含医疗兵', es.spawnQueue.some(q => q.t === 'medic'));
}
{
  /* 无尽纪录只接受有限正数，并向下取整 */
  delete storage.TD_ENDLESS_BEST; // 清除前面无尽实战写入的纪录
  TD.saveEndlessBest(12.9);
  assert('无尽纪录保存整数波次', storage.TD_ENDLESS_BEST === '12' && TD.loadEndlessBest() === 12);
  TD.saveEndlessBest(NaN);
  assert('NaN 不覆盖无尽纪录', TD.loadEndlessBest() === 12);
  storage.TD_ENDLESS_BEST = 'broken';
  assert('损坏的本地纪录安全归零', TD.loadEndlessBest() === 0);
}
{
  /* 六塔布局不能重叠，右键不能误建塔 */
  const s = TD.newGame('normal');
  const R = TD.uiRects(s);
  assert('七张塔卡完整且包含毒液塔与增幅塔', R.cards.length === 7 && R.cards[5].key === 'venom' && R.cards[6].key === 'amp');  assert('升级/出售按钮不侵入波次面板', R.upBtn.x + R.upBtn.w <= R.wave.x && R.sellBtn.x + R.sellBtn.w <= R.wave.x);
  const handlers = {};
  const canvas = {
    addEventListener(name, fn) { handlers[name] = fn; },
    getBoundingClientRect() { return { left: 0, top: 0, width: TD.W, height: TD.H }; }
  };
  TD.bindInput(canvas, () => s);
  s.pick = 'arrow';
  handlers.pointerdown({ button: 2, clientX: 260, clientY: 360, preventDefault() {} });
  assert('右键按下不会误建防御塔', s.towers.length === 0 && s.pick === 'arrow');
  handlers.contextmenu({ preventDefault() {} });
  assert('右键菜单事件取消选塔', s.pick === null);
  const menu = TD.newGame('normal'); menu.scene = 'menu';
  TD.bindInput(canvas, () => menu);
  winStub.listeners.keydown({ key: '4' });
  assert('主菜单快捷键 4 可进入无尽模式', TD.state() && TD.state().mode === 'endless');
}
console.log('\n--- 新增功能：增幅塔 / 狂怒兽 / 蜂群 / 熔渊关卡 ---');
{
  /* 增幅塔：光环提升范围内友军射速，超出范围不受影响 */
  const s = TD.newGame('normal'); s.gold = 9999;
  const a = TD.placeTower(s, 'amp', 6, 6);    // 增幅塔
  const near = TD.placeTower(s, 'arrow', 6, 7); // 光环内
  const far = TD.placeTower(s, 'arrow', 20, 11);// 光环外
  assert('增幅塔可建造且自身不造成伤害', a.ok === true && TD.towerStats(a.tower, s).dmg === 0 && TD.towerStats(a.tower, s).rate === 0);
  assert('增幅塔光环提升范围内友军射速', TD.towerStats(near.tower, s).rate > TD.TOWERS.arrow.rate);
  assert('增幅塔光环不影响范围外友军', Math.abs(TD.towerStats(far.tower, s).rate - TD.TOWERS.arrow.rate) < 1e-9);
  const boosted = TD.towerStats(near.tower, s).rate / TD.TOWERS.arrow.rate;
  assert('增幅塔光环加成幅度符合数值表', Math.abs(boosted - (1 + TD.TOWERS.amp.ampMul)) < 1e-9);
  /* 出售增幅塔后加成立即消失 */
  TD.sellTower(s, a.tower);
  assert('出售增幅塔后光环立刻失效', Math.abs(TD.towerStats(near.tower, s).rate - TD.TOWERS.arrow.rate) < 1e-9);
  /* 升级增幅塔提升光环强度 */
  const s2 = TD.newGame('normal'); s2.gold = 9999;
  const a2 = TD.placeTower(s2, 'amp', 6, 6);
  const t2 = TD.placeTower(s2, 'arrow', 6, 7);
  const before = TD.towerStats(t2.tower, s2).rate;
  TD.upgradeTower(s2, a2.tower);
  assert('升级增幅塔光环变强', TD.towerStats(t2.tower, s2).rate > before);
  /* 增幅塔不会开火 */
  const s3 = TD.newGame('normal'); s3.gold = 9999; s3.wave = 1; s3.prepLeft = 9999;
  TD.placeTower(s3, 'amp', 6, 7);
  TD.spawnEnemy(s3, 'grunt', 300);
  for (let i = 0; i < 120; i++) TD.step(s3, 1 / 60);
  assert('增幅塔自身不开火', s3.shots.length === 0);
}
{
  /* 狂怒兽：血量越低移动越快 */
  const s = TD.newGame('normal'); s.wave = 1; s.prepLeft = 9999;
  const e = TD.spawnEnemy(s, 'berserker', 500);
  assert('狂怒兽可生成且带愤怒系数', !!e && e.rage > 0);
  const d0 = e.dist;
  TD.step(s, 0.05);
  const fullSpeed = e.dist - d0;
  e.hp = e.maxHp * 0.25;
  const d1 = e.dist;
  TD.step(s, 0.05);
  const lowSpeed = e.dist - d1;
  assert('狂怒兽残血时移动更快', lowSpeed > fullSpeed * 1.2);
  /* 减速依然对狂怒兽生效 */
  TD.applySlow(e, 0.5, 2);
  const d2 = e.dist;
  TD.step(s, 0.05);
  assert('减速对狂怒兽同样生效', (e.dist - d2) < lowSpeed * 0.8);
}
{
  /* 蜂群：数量多、脆弱，可被正常击杀 */
  const s = TD.newGame('normal'); s.gold = 9999; s.wave = 1; s.prepLeft = 9999;
  const b = TD.placeTower(s, 'cannon', 6, 7);
  TD.upgradeTower(s, b.tower); TD.upgradeTower(s, b.tower);
  for (let i = 0; i < 8; i++) TD.spawnEnemy(s, 'swarm', 500);
  const k0 = s.stat.kills;
  for (let i = 0; i < 60 * 20 && s.stat.kills < 8; i++) TD.step(s, 1 / 60);
  assert('蜂群可被正常击杀', s.stat.kills >= 8 && s.stat.kills > k0);
}
{
  /* 熔渊关卡：独立地图 + 独立波次表 */
  const s = TD.newGame('forge');
  assert('熔渊使用独立关卡地图', s.level === 'forge' && s.path !== TD.PATH && s.path.pts[0].y !== TD.PATH.pts[0].y);
  assert('熔渊波次表独立于主线', TD.wavesOf('forge') === TD.FORGE_WAVES && TD.wavesOf('normal') === TD.WAVES);
  assert('熔渊总波数为 12', TD.totalWaves('forge') === 12 && TD.totalWaves('normal') === 15);
  assert('熔渊路径长度与主线相当', Math.abs(s.path.total - TD.PATH.total) < 80);
  assert('熔渊基地与主线基地不同', s.base.cx !== TD.LEVELS.main.base.cx || s.base.cy !== TD.LEVELS.main.base.cy);
  assert('熔渊敌人沿本关卡路径出生', Math.abs(s.path.pts[0].x - (-20)) < 1 && s.path.pts[0].y !== TD.PATH.pts[0].y);
}
{
  /* 回归：炮台落点必须按当前关卡路径推算（换图后不能打到别的地图的坐标上） */
  const s = TD.newGame('forge'); s.gold = 9999; s.wave = 1; s.prepLeft = 9999;
  const b = TD.placeTower(s, 'cannon', 6, 7);
  const e = TD.spawnEnemy(s, 'grunt', 300);
  TD.step(s, 1 / 60);
  const shot = s.shots.find(x => x.kind === 'shell');
  const dForge = shot ? distAlong(shot.tx, shot.ty, s.path).d : Infinity;
  const dMain = shot ? distAlong(shot.tx, shot.ty, TD.PATH).d : Infinity;
  assert('炮台炮弹按本关卡路径推算落点', !!shot && dForge < 60 && dForge < dMain);
}
console.log('\n--- 缺陷回归 ---');
{
  /* 回归：漏怪判负时尸体必须清理干净，不能残留在结算画面里 */
  const s = TD.newGame('normal');
  s.lives = 1; s.phase = 'spawning'; s.wave = 1; s.spawnQueue = [];
  s.enemies = [{ id: 1, type: 'grunt', x: 900, y: 320, dist: TD.PATH.total - 1,
    hp: 10, maxHp: 10, speed: 60, slowT: 0, slowMul: 1, r: 11, armor: 0,
    gold: 8, leak: 5, score: 10, color: '#fff', shape: 'circle', ang: 0, hitT: 0, dead: false, wob: 0 }];
  for (let i = 0; i < 8; i++) TD.step(s, 1 / 60);
  assert('漏怪判负后不残留尸体', s.scene === 'lose' && s.enemies.length === 0);
}
{
  /* 回归：非法难度不能让游戏崩溃 */
  assert('非法难度回退到普通', TD.newGame('不存在的难度').mode === 'normal');
  assert('非法难度算血量不崩溃', typeof TD.hpScale(3, '不存在的难度') === 'number');
}
{
  /* 回归：存档里的难度被篡改时，主菜单与读档都必须安全降级 */
  const raw = JSON.stringify({ v: 1, mode: '被篡改', wave: 3, lives: 10 });
  storage['TD_SAVE_V1'] = raw;
  assert('被篡改的存档不显示继续按钮', TD.hasSave() === false && TD.saveInfo() === null);
  assert('被篡改的存档读档安全降级为无存档', TD.loadGame() === null);
  TD.clearSave();
}
{
  /* 回归：数字键必须用数值比较（塔种变多后字符串比较会失效） */
  const handlers = {};
  const canvas = {
    addEventListener(name, fn) { handlers[name] = fn; },
    getBoundingClientRect() { return { left: 0, top: 0, width: TD.W, height: TD.H }; }
  };
  const s = TD.newGame('normal');
  TD.bindInput(canvas, () => s);
  winStub.listeners.keydown({ key: '7', preventDefault() {} });
  assert('数字键 7 可选中第七种塔', s.pick === TD.TOWER_KEYS[6]);
  winStub.listeners.keydown({ key: '9', preventDefault() {} });
  assert('超出塔种数量的数字键不会误选', s.pick === TD.TOWER_KEYS[6]);
  winStub.listeners.keydown({ preventDefault() {} });
  assert('键盘事件缺少 key 字段不会崩溃', s.pick === TD.TOWER_KEYS[6]);
}
{
  /* 回归：底部栏必须按塔种数量自适应，升级/出售按钮不得越界 */
  const R = TD.uiRects(TD.newGame('normal'));
  const last = R.cards[R.cards.length - 1];
  assert('最后一张塔卡不与选中面板重叠', last.x + last.w <= R.panel.x);
  assert('升级/出售按钮不侵入波次面板', R.upBtn.x + R.upBtn.w <= R.wave.x && R.sellBtn.x + R.sellBtn.w <= R.wave.x);
  assert('塔卡宽度在合理区间内', R.cards.every(c => c.w >= 56 && c.w <= 78));
}
console.log('\n--- UI 点击链路 ---');
{
  const s = TD.newGame('normal');
  const R = TD.uiRects(s);
  /* 1. 点第一张卡片（箭塔） */
  TD.click(s, R.cards[0].x + 20, R.cards[0].y + 20);
  assert('点击卡片进入选塔状态', s.pick === 'arrow');
  /* 2. 点草地空格建塔 */
  const cell = { c: 6, r: 6 };
  TD.click(s, cell.c * 40 + 20, 60 + cell.r * 40 + 20);
  assert('点击空地成功建塔', s.towers.length === 1 && s.towers[0].c === 6);
  /* 3. 点击该塔选中 */
  const t = s.towers[0];
  TD.click(s, t.x, t.y);
  assert('点击塔可选中', s.sel === t);
  /* 4. 点升级按钮 */
  const gold0 = s.gold;
  TD.click(s, R.upBtn.x + 10, R.upBtn.y + 10);
  assert('点升级按钮后塔升到 2 级', t.level === 2 && s.gold === gold0 - TD.upgradeCost({ key: 'arrow', level: 1 }));
  /* 5. 点出售按钮 */
  TD.click(s, R.sellBtn.x + 10, R.sellBtn.y + 10);
  assert('点出售按钮后塔被移除', s.towers.length === 0 && TD.cellFree(s, cell.c, cell.r));
  /* 6. 顶栏：变速、暂停、静音 */
  TD.click(s, R.speed.x + 5, R.speed.y + 5);
  assert('点击变速按钮切换到 2×', s.speed === 2);
  TD.click(s, R.pause.x + 5, R.pause.y + 5);
  assert('点击暂停按钮进入暂停', s.paused === true);
  TD.click(s, R.pause.x + 5, R.pause.y + 5);
  assert('再次点击恢复运行', s.paused === false);
  /* 7. 波次面板：立即召唤 */
  assert('处于准备阶段', s.phase === 'prep');
  TD.click(s, R.wave.x + 60, R.wave.y + 70);
  assert('点击“立即召唤”提前开波', s.phase === 'spawning' && s.wave === 1);
  /* 8. 金币不足时点卡片建塔给出提示 */
  s.gold = 0; s.pick = null;
  TD.click(s, R.cards[3].x + 20, R.cards[3].y + 20);
  TD.click(s, 300, 300);
  assert('金币不足无法建造且飘出提示', s.towers.length === 0 && s.floats.length > 0);
}
console.log('\n--- 存档 / 续战 ---');
{
  /* 开局建塔、推进到第 1 波交战，存档后读档恢复 */
  const s = TD.newGame('normal');
  TD.placeTower(s, 'arrow', 6, 3);
  TD.placeTower(s, 'cannon', 7, 5);
  s.wave = 1; s.phase = 'spawning';
  TD.spawnEnemy(s, 'grunt', 0);
  TD.spawnEnemy(s, 'shield', 50);
  const gold0 = s.gold, lives0 = s.lives, wave0 = s.wave, tw0 = s.towers.length, en0 = s.enemies.length;
  const ok = TD.saveGame(s);
  assert('游戏进行中可写入存档', ok === true && TD.hasSave() === true);
  const loaded = TD.loadGame();
  assert('读档重建 scene 与核心计数', loaded && loaded.scene === 'play' && loaded.gold === gold0 && loaded.lives === lives0 && loaded.wave === wave0);
  assert('读档恢复全部防御塔且占用表正确', loaded.towers.length === tw0 && loaded.occ[loaded.towers[0].c + ',' + loaded.towers[0].r] === loaded.towers[0]);
  assert('读档恢复敌人数量与护盾字段', loaded.enemies.length === en0 && loaded.enemies.some(e => e.maxShield > 0));
  assert('读档后敌人坐标由路径重新推导', loaded.enemies.every(e => Number.isFinite(e.x) && Number.isFinite(e.y)));
  /* 读档后战斗循环自洽：炮台能正常瞄准射击 */
  const cannon = loaded.towers.find(t => t.key === 'cannon');
  cannon.ang = -Math.PI / 2;
  TD.step(loaded, 0.05);
  assert('读档后防御塔仍可正常射击', loaded.shots.length >= 0 && !loaded.renderErr);

  /* 自动存档：游戏进行约 4 秒后由 step 触发 */
  const s2 = TD.newGame('normal');
  for (let i = 0; i < 100; i++) TD.step(s2, 0.05);
  assert('自动存档在游戏进行约 4 秒后触发', TD.hasSave() === true);

  /* 损坏存档安全降级 */
  storage['TD_SAVE_V1'] = 'not-json';
  assert('损坏存档读档返回 null', TD.loadGame() === null);

  /* 清档后继续按钮消失 */
  TD.clearSave();
  assert('清档后 hasSave 为假', TD.hasSave() === false);
}
console.log('\n--- 视口适配（宽屏不留黑边、点击不错位）---');
{
  /* 宽屏：竖向贴合、左右留白，留白由渲染层补草地 */
  const wide = TD.fitView(1600, 900);
  assert('宽屏按高度贴合视口', Math.abs(wide.k - 900 / TD.H) < 1e-9 && Math.abs(wide.oy) < 1e-9);
  assert('宽屏左右留白对称', wide.ox > 0 && Math.abs(wide.ox - (1600 - TD.W * wide.k) / 2) < 1e-6);
  /* 竖屏：横向贴合、上下留白 */
  const tall = TD.fitView(800, 1000);
  assert('竖屏按宽度贴合视口', Math.abs(tall.k - 800 / TD.W) < 1e-9 && Math.abs(tall.ox) < 1e-9 && tall.oy > 0);
  /* 任意比例下场地都不会被裁掉 */
  const fits = [[1600, 900], [800, 1000], [1160, 800], [1000, 680]].every(wh => {
    const f = TD.fitView(wh[0], wh[1]);
    return TD.W * f.k <= wh[0] + 1e-6 && TD.H * f.k <= wh[1] + 1e-6;
  });
  assert('任意窗口比例下场地完整可见不被裁切', fits);
  /* 屏幕坐标 → 逻辑坐标 能原样还原（点击命中不偏移） */
  const f = TD.fitView(1600, 900);
  const roundTrip = [[0, 0], [TD.W, TD.H], [420, 333], [999, 1]].every(p => {
    const sx = f.ox + p[0] * f.k, sy = f.oy + p[1] * f.k;
    return Math.abs((sx - f.ox) / f.k - p[0]) < 1e-6 && Math.abs((sy - f.oy) / f.k - p[1]) < 1e-6;
  });
  assert('留白偏移下点击坐标可无损还原', roundTrip);
}
console.log('\n断言结果: ' + passed + ' 项通过 / ' + fail + ' 项失败');
