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
  innerWidth: 1400, innerHeight: 900, devicePixelRatio: 1,
  addEventListener() {}, requestAnimationFrame() {}, __TD_NO_BOOT__: true
};
const docStub = { getElementById: () => null, addEventListener() {}, readyState: 'complete' };
new Function('window', 'document', 'requestAnimationFrame', 'performance', 'console', m[1])(
  winStub, docStub, () => {}, { now: Date.now }, console);

const TD = winStub.TD;
if (!TD) throw new Error('游戏未导出 TD API');

const CELL = TD.CELL;
function cx(c) { return c * CELL + CELL / 2; }
function cy(r) { return 60 + r * CELL + CELL / 2; }

/* 路径上某点距起点的距离（用于给建造点排序：沿路依次布置） */
function distAlong(x, y) {
  const pts = TD.PATH.pts;
  let best = { d: Infinity, along: 0 };
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x, ay = pts[i - 1].y, bx = pts[i].x, by = pts[i].y;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((x - ax) * dx + (y - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, py = ay + dy * t;
    const d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { d, along: TD.PATH.cum[i - 1] + Math.sqrt(len2) * t };
  }
  return best;
}

let SPOTS = null;
function spots(s) {
  if (SPOTS) return SPOTS;
  SPOTS = TD.buildableCells(s).map(p => {
    const r = distAlong(cx(p.c), cy(p.r));
    return { c: p.c, r: p.r, gap: r.d, along: r.along };
  }).filter(p => p.gap < CELL * 1.2)
    .sort((a, b) => a.along - b.along);
  return SPOTS;
}

/* 一个有经验的玩家会用的建塔顺序 */
const PLAN = ['arrow', 'frost', 'arrow', 'cannon', 'arrow', 'tesla', 'cannon', 'sniper',
  'frost', 'arrow', 'tesla', 'cannon', 'sniper', 'arrow', 'cannon', 'frost',
  'tesla', 'sniper', 'cannon', 'arrow', 'tesla', 'cannon', 'frost', 'sniper',
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

  while (s.scene === 'play' && frames < 60 * 60 * 25) {
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
        const cand = s.towers.filter(t => t.level < TD.MAX_LV)
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
for (const mode of ['easy', 'normal', 'hard']) {
  const r = run(mode);
  console.log(`[${r.mode}] ${r.scene}  到第 ${r.wave}/${TD.WAVES.length} 波  剩余生命 ${r.lives}  得分 ${r.score}  塔 ${r.towers}  击杀 ${r.kills}  漏怪 ${r.leaked}  时长 ${r.simSec}s  渲染异常 ${r.renderErr || '无'}`);
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

console.log('\n=== 单元断言 ===');
let fail = 0;
function assert(name, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name);
  if (!cond) { fail++; process.exitCode = 1; }
}
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
  assert('最高 3 级封顶', t.level === 3 && TD.upgradeTower(s, t).ok === false);
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
console.log('\n断言失败数: ' + fail);
