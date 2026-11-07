/* 一次性排查工具：随机状态 + 不变量校验，用来挖隐藏 bug（不是游戏本体，可删除） */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
const winStub = {
  innerWidth: 1400, innerHeight: 900, devicePixelRatio: 1, listeners: {},
  addEventListener(n, f) { this.listeners[n] = f; }, requestAnimationFrame() {}, __TD_NO_BOOT__: true
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

/* 确定性随机，方便复现 */
let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n) { return Math.floor(rnd() * n); }
function pick(arr) { return arr[ri(arr.length)]; }

const problems = [];
function bad(msg) { problems.push(msg); }

/* ---- 不变量检查 ---- */
function checkInvariants(s, tag) {
  if (!Number.isFinite(s.gold) || s.gold < 0) bad(tag + ' 金币非法: ' + s.gold);
  if (!Number.isFinite(s.lives) || s.lives < 0) bad(tag + ' 生命非法: ' + s.lives);
  if (!Number.isFinite(s.score)) bad(tag + ' 得分非法: ' + s.score);
  if (!Number.isFinite(s.time)) bad(tag + ' 时间非法: ' + s.time);
  for (const e of s.enemies) {
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) bad(tag + ' 敌人坐标 NaN: ' + e.type);
    if (!Number.isFinite(e.hp)) bad(tag + ' 敌人生命 NaN: ' + e.type);
    if (e.dead) bad(tag + ' 残留 dead 敌人未被清理: ' + e.type);
    if (e.dist < -0.001) bad(tag + ' 敌人路径距离为负: ' + e.dist);
    if (e.hp > e.maxHp + 0.001) bad(tag + ' 敌人生命超过上限: ' + e.hp + '>' + e.maxHp);
    if (e.shield > e.maxShield + 0.001) bad(tag + ' 护盾超过上限');
    if (e.slowT < 0) bad(tag + ' 减速计时为负');
    if (e.poisonT < 0) bad(tag + ' 毒素计时为负');
  }
  for (const t of s.towers) {
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) bad(tag + ' 塔坐标 NaN');
    if (t.level < 1 || t.level > TD.MAX_LV) bad(tag + ' 塔等级越界: ' + t.level);
    if (!Number.isFinite(t.cd)) bad(tag + ' 塔冷却 NaN');
    if (s.occ[t.c + ',' + t.r] !== t) bad(tag + ' 占位表与塔列表不一致');
  }
  if (Object.keys(s.occ).length !== s.towers.length) {
    bad(tag + ' 占位表数量(' + Object.keys(s.occ).length + ') != 塔数量(' + s.towers.length + ')');
  }
  for (const sh of s.shots) {
    if (!Number.isFinite(sh.x) || !Number.isFinite(sh.y)) bad(tag + ' 子弹坐标 NaN kind=' + sh.kind);
  }
}

/* ---- 随机对局 fuzz ---- */
const TOWER_LIST = Object.keys(TD.TOWERS);
const ENEMY_LIST = Object.keys(TD.ENEMIES);

function fuzzRun(rounds) {
  for (let round = 0; round < rounds; round++) {
    const mode = pick(['easy', 'normal', 'hard', 'endless']);
    const s = TD.newGame(mode);
    s.gold = 99999;
    const ctx = makeCtx();
    for (let step = 0; step < 900; step++) {
      const r = rnd();
      try {
        if (r < 0.18) {
          const cells = TD.buildableCells(s);
          if (cells.length) {
            const c = pick(cells);
            TD.placeTower(s, pick(TOWER_LIST), c.c, c.r);
          }
        } else if (r < 0.28) {
          if (s.towers.length) {
            const t = pick(s.towers);
            if (rnd() < 0.6) TD.upgradeTower(s, t); else TD.sellTower(s, t);
          }
        } else if (r < 0.42) {
          const type = pick(ENEMY_LIST);
          const e = TD.spawnEnemy(s, type, rnd() * TD.PATH.total);
          if (e) {
            /* 随机施加状态 */
            if (rnd() < 0.4) e.slowT = rnd() * 3;
            if (rnd() < 0.3) { e.poisonDps = 5; e.poisonT = 2; }
            if (rnd() < 0.3) { e.shred = 0.1; e.shredT = 2; }
            if (rnd() < 0.3) e.shield = e.maxShield;
          }
        } else if (r < 0.47) {
          TD.callWaveEarly(s);
        } else if (r < 0.50) {
          s.speed = pick([1, 2, 3]);
        } else if (r < 0.53) {
          s.paused = !s.paused;
        } else if (r < 0.57) {
          const R = TD.uiRects(s);
          TD.click(s, R.cards[ri(R.cards.length)].x + 10, R.cards[ri(R.cards.length)].y + 10);
        } else if (r < 0.62) {
          /* 随机乱点 */
          TD.click(s, rnd() * 1000, rnd() * 680);
        } else if (r < 0.66) {
          /* 强行制造漏怪 */
          if (s.enemies.length) { const e = pick(s.enemies); e.dist = TD.PATH.total + 1; }
        } else if (r < 0.70) {
          /* 存档 / 读档 */
          TD.saveGame(s);
          const l = TD.loadGame();
          if (l) { checkInvariants(l, tagOf(round, step) + ' 读档'); }
        }
        TD.step(s, 1 / 60);
        TD.draw(s, ctx);
        checkInvariants(s, tagOf(round, step));
      } catch (err) {
        bad(tagOf(round, step) + ' 抛出异常: ' + err && err.stack ? err.stack : String(err));
        break;
      }
      if (problems.length > 25) return;
    }
  }
}
function tagOf(round, step) { return '[r' + round + 's' + step + ']'; }

console.log('=== fuzz：随机对局 ===');
fuzzRun(60);

console.log('\n=== 边界输入 ===');
function edge(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + ' → ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); problems.push(name); }
}
edge('非法 mode 开局回退到普通', () => {
  const s = TD.newGame('不存在的难度');
  if (s.mode !== 'normal') throw new Error('mode=' + s.mode);
});
edge('hpScale 非法 mode 不崩溃', () => {
  TD.hpScale(3, '不存在的难度');
});
edge('存档 mode 被篡改后主菜单不崩溃', () => {
  storage['TD_SAVE_V1'] = JSON.stringify({ v: 1, mode: 'evil', wave: 3, lives: 10 });
  const s = TD.newGame('normal');
  s.scene = 'menu';
  TD.draw(s, makeCtx());
});
edge('存档 mode 被篡改后读档不崩溃', () => {
  storage['TD_SAVE_V1'] = JSON.stringify({ v: 1, mode: 'evil', wave: 3, lives: 10 });
  const l = TD.loadGame();
  if (l) { TD.step(l, 1 / 60); TD.draw(l, makeCtx()); }
});
edge('存档字段缺失时读档不崩溃', () => {
  storage['TD_SAVE_V1'] = JSON.stringify({ v: 1 });
  const l = TD.loadGame();
  if (l) { TD.step(l, 1 / 60); TD.draw(l, makeCtx()); }
});
edge('塔卡数量与快捷键数量一致', () => {
  const R = TD.uiRects(TD.newGame('normal'));
  if (R.cards.length !== Object.keys(TD.TOWERS).length) throw new Error('卡片数不匹配');
});
edge('底部栏按钮不越界（升级/出售不侵入波次面板）', () => {
  const R = TD.uiRects(TD.newGame('normal'));
  if (R.upBtn.x + R.upBtn.w > R.wave.x) throw new Error('升级按钮越界 ' + (R.upBtn.x + R.upBtn.w) + '>' + R.wave.x);
  if (R.sellBtn.x + R.sellBtn.w > R.wave.x) throw new Error('出售按钮越界');
});
edge('底部栏最后一张卡不越界', () => {
  const R = TD.uiRects(TD.newGame('normal'));
  const last = R.cards[R.cards.length - 1];
  if (last.x + last.w > R.panel.x) throw new Error('卡片与面板重叠');
});
edge('键盘 7+ 可选塔（字符串比较陷阱）', () => {
  const canvas = { addEventListener() {}, getBoundingClientRect() { return { left: 0, top: 0, width: TD.W, height: TD.H }; } };
  const s = TD.newGame('normal');
  TD.bindInput(canvas, () => s);
  winStub.listeners.keydown({ key: String(Object.keys(TD.TOWERS).length), preventDefault() {} });
  const keys = Object.keys(TD.TOWERS);
  if (s.pick !== keys[keys.length - 1]) throw new Error('最后一个塔无法用数字键选中, pick=' + s.pick);
});
edge('keydown 事件缺少 key 字段不崩溃', () => {
  const canvas = { addEventListener() {}, getBoundingClientRect() { return { left: 0, top: 0, width: TD.W, height: TD.H }; } };
  const s = TD.newGame('normal');
  TD.bindInput(canvas, () => s);
  winStub.listeners.keydown({ preventDefault() {} });
});
edge('鼠标点击超出画布边界不崩溃', () => {
  const s = TD.newGame('normal');
  TD.click(s, -500, -500);
  TD.click(s, 99999, 99999);
});
edge('无敌人时点击建造仍受金币约束', () => {
  const s = TD.newGame('normal'); s.gold = 0; s.pick = 'arrow';
  TD.click(s, 300, 300);
  if (s.towers.length) throw new Error('零金币仍建成');
});

console.log('\n=== 碰撞检测专项 ===');
/* 子弹与目标同位置 */
{
  const s = TD.newGame('normal'); s.wave = 1; s.prepLeft = 9999;
  const e = TD.spawnEnemy(s, 'grunt', 500);
  s.shots.push({ kind: 'homing', x: e.x, y: e.y, target: e, dmg: 10, speed: 500, color: '#fff', src: null, ang: 0 });
  TD.step(s, 0.05);
  console.log('  同位置子弹: ' + (e.hp === e.maxHp - 10 ? 'ok' : 'FAIL hp=' + e.hp));
  if (e.hp !== e.maxHp - 10) problems.push('同位置子弹未命中');
}
/* 目标中途死亡，子弹应消失且不残留 */
{
  const s = TD.newGame('normal'); s.wave = 1; s.prepLeft = 9999;
  const e = TD.spawnEnemy(s, 'grunt', 500);
  s.shots.push({ kind: 'homing', x: e.x - 200, y: e.y, target: e, dmg: 10, speed: 500, color: '#fff', src: null, ang: 0 });
  e.dead = true;
  TD.step(s, 0.05);
  console.log('  目标已死子弹清除: ' + (s.shots.length === 0 ? 'ok' : 'FAIL ' + s.shots.length));
  if (s.shots.length !== 0) problems.push('目标死亡后子弹残留');
}
/* 霜塔脉冲：减速必须真正生效（速度下降）
   注意 step() 内部把单帧 dt 截断到 0.05 秒，所以位移按 0.05 秒算，不是传入值 */
{
  const s = TD.newGame('normal'); s.wave = 1; s.prepLeft = 9999;
  const e = TD.spawnEnemy(s, 'grunt', 500);
  TD.applySlow(e, 0.45, 2);
  const d0 = e.dist;
  TD.step(s, 0.05);
  const moved = e.dist - d0;
  const unslow = e.speed * 0.05;          // 未减速时的位移
  const expect = e.speed * 0.45 * 0.05;   // 减速 45% 后的位移
  console.log('  减速生效: ' + (moved < unslow * 0.9 && Math.abs(moved - expect) < 0.01 ? 'ok' : 'FAIL moved=' + moved.toFixed(3) + ' 未减速应为' + unslow.toFixed(3)));
  if (!(moved < unslow * 0.9 && Math.abs(moved - expect) < 0.01)) problems.push('减速未正确影响移动速度');
}
/* 多个霜塔叠加：强减速不应被弱减速覆盖 */
{
  const s = TD.newGame('normal');
  const e = TD.spawnEnemy(s, 'grunt', 500);
  TD.applySlow(e, 0.45, 2);
  TD.applySlow(e, 0.7, 2);
  console.log('  弱减速不覆盖强减速: ' + (e.slowMul === 0.45 ? 'ok' : 'FAIL mul=' + e.slowMul));
  if (e.slowMul !== 0.45) problems.push('弱减速覆盖了强减速');
}
/* 连锁闪电：第一跳目标死亡分裂，幼虫不应被同一次连锁重复命中 */
{
  const s = TD.newGame('normal'); s.gold = 9999;
  const b = TD.placeTower(s, 'tesla', 6, 7);
  const e = TD.spawnEnemy(s, 'splitter', 300);
  e.hp = 1;
  const mitesBefore = s.enemies.filter(x => x.type === 'mite').length;
  TD.chainLightning(s, b.tower, e, TD.towerStats(b.tower));
  const mites = s.enemies.filter(x => x.type === 'mite');
  console.log('  分裂生成幼虫数: ' + (mites.length - mitesBefore) + ' ' + (mites.length - mitesBefore === 2 ? 'ok' : 'FAIL'));
  if (mites.length - mitesBefore !== 2) problems.push('连锁分裂产生的幼虫数量异常');
}
/* 炮台范围伤害必须命中半径内但不能命中半径外 */
{
  const s = TD.newGame('normal'); s.wave = 1; s.prepLeft = 9999;
  const near = TD.spawnEnemy(s, 'grunt', 500);
  const far = TD.spawnEnemy(s, 'grunt', 500);
  near.x = 300; near.y = 300; far.x = 300 + 52 + 20; far.y = 300;
  const hpN = near.hp, hpF = far.hp;
  TD.areaDamage(s, 300, 300, 52, 30, 0, 0, null);
  console.log('  范围伤害内命中: ' + (near.hp < hpN ? 'ok' : 'FAIL') + '，范围外不命中: ' + (far.hp === hpF ? 'ok' : 'FAIL'));
  if (near.hp >= hpN) problems.push('范围内敌人未被命中');
  if (far.hp !== hpF) problems.push('范围外敌人被误伤');
}
/* 子弹飞行中目标移动：追踪弹必须跟上 */
{
  const s = TD.newGame('normal'); s.wave = 1; s.prepLeft = 9999;
  const e = TD.spawnEnemy(s, 'grunt', 500);
  const hp0 = e.hp;
  s.shots.push({ kind: 'homing', x: e.x - 300, y: e.y, target: e, dmg: 20, speed: 400, color: '#fff', src: null, ang: 0 });
  for (let i = 0; i < 60; i++) TD.step(s, 1 / 60);
  console.log('  追踪弹命中移动目标: ' + (e.hp < hp0 ? 'ok' : 'FAIL'));
  if (e.hp >= hp0) problems.push('追踪弹未命中移动目标');
}

console.log('\n=== 敌人生成专项 ===');
/* 未知类型 */
{
  const s = TD.newGame('normal');
  console.log('  未知类型返回 null: ' + (TD.spawnEnemy(s, 'nope') === null ? 'ok' : 'FAIL'));
}
/* 生成顺序：spawnQueue 的敌人应按队列顺序出场
   注意 callWaveEarly 会把 wave +1，所以要取的是下一波的波次表 */
{
  const s = TD.newGame('normal');
  s.wave = 2; s.prepLeft = 0;
  TD.callWaveEarly(s);
  const q = s.spawnQueue.map(x => x.t).join(',');
  const expect = TD.WAVES[2].map(g => new Array(g.n).fill(g.t)).join(',');
  console.log('  出怪队列顺序与波次表一致: ' + (q === expect ? 'ok' : 'FAIL'));
  if (q !== expect) problems.push('出怪队列顺序错误');
}
/* 所有敌人类型都能生成且字段完整 */
{
  const s = TD.newGame('normal'); s.wave = 1;
  let ok = true;
  for (const k of Object.keys(TD.ENEMIES)) {
    const e = TD.spawnEnemy(s, k);
    if (!e || !Number.isFinite(e.hp) || e.hp <= 0 || !Number.isFinite(e.x)) { ok = false; problems.push('敌人类型 ' + k + ' 生成异常'); }
  }
  console.log('  全部敌人类型可正常生成: ' + (ok ? 'ok' : 'FAIL'));
}
/* 血量缩放随波次单调递增 */
{
  const s = TD.newGame('normal');
  let ok = true, prev = 0;
  for (let w = 1; w <= 15; w++) {
    const hp = Math.round(TD.ENEMIES.grunt.hp * TD.hpScale(w, 'normal'));
    if (hp <= prev) { ok = false; }
    prev = hp;
  }
  console.log('  血量缩放随波次递增: ' + (ok ? 'ok' : 'FAIL'));
}

console.log('\n=== 结果 ===');
if (!problems.length) console.log('未发现问题');
else {
  console.log('发现 ' + problems.length + ' 个问题：');
  const seen = new Set();
  for (const p of problems) { if (!seen.has(p)) { seen.add(p); console.log(' - ' + p); } }
}
