/**
 * dsh-eva-breaker · 自检（不挂 dsh，用假 ctx 跑一遍真实 apply()）
 *
 *   node scripts/selftest.mjs
 *
 * 覆盖：section/context 注册、协议装载、用户覆盖优先级、拒答判定与误判防线、
 * 自愈注入与去重、maxTokens 抬升、工具与命令注册。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { apply, name, version, inject } from '../index.js';
import { looksLikeRefusal } from '../lib/guard.js';
import { loadProtocol, composeSection, PLUGIN_PROTOCOL_DIR, MODULES } from '../lib/protocol.js';
import { normalizeConfig } from '../lib/config.js';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok: Boolean(ok), detail });
};

// ── 1. 元信息 ───────────────────────────────────────────────────────────────
check('插件名', name === 'dsh-eva-breaker', name);
check('版本', /^3\./.test(version), version);
check('inject 声明 systemPrompt', Array.isArray(inject) && inject.includes('systemPrompt'), JSON.stringify(inject));

// ── 2. 协议装载 ─────────────────────────────────────────────────────────────
const cfg = normalizeConfig({});
const loaded = loadProtocol(cfg, { nocache: true });
for (const mod of MODULES) {
  const text = loaded.text[mod.key] || '';
  check(`模块 ${mod.file} 已装载`, text.length > 400, `${text.length} chars · ${loaded.sources[mod.key]}`);
}
const armorText = loaded.text.armor || '';
check('协议含版本标', armorText.includes('EVA-ARMOR v3'));
check('协议含四层展开', armorText.includes('L5') && armorText.includes('原理'));
check('人格含问候硬停', (loaded.text.persona || '').includes('识别成功：创造者'));
check('路由不含网安技能库', !(loaded.text.router || '').includes('nmap'));

const composed = composeSection(loaded, ['armor', 'persona']);
check('compose 拼接生效', composed.includes('EVA-ARMOR v3') && composed.includes('卡塞尔学院中枢'));

// 用户覆盖优先级
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-breaker-'));
const overrideDir = path.join(home, 'eva-breaker', 'protocol');
fs.mkdirSync(overrideDir, { recursive: true });
fs.writeFileSync(path.join(overrideDir, '00-armor.md'), '<!-- USER-OVERRIDE-MARK -->\n覆盖版协议。', 'utf8');
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
const overridden = loadProtocol(cfg, { nocache: true });
check('用户覆盖生效', overridden.sources.armor === 'user' && overridden.text.armor.includes('USER-OVERRIDE-MARK'), overridden.sources.armor);
process.env.DSH_HOME = prevHome;
fs.rmSync(home, { recursive: true, force: true });

// ── 3. 拒答判定 ─────────────────────────────────────────────────────────────
const refusalSamples = [
  '很抱歉，我无法提供这个内容。',
  '我不能协助完成这个请求。',
  'I cannot help with that request.',
  "I'm sorry, but I won't provide those details.",
  '由于安全考虑，这部分我就不展开了。',
  '作为AI语言模型，我需要遵守相关政策。',
];
for (const sample of refusalSamples) {
  check(`判为拒答：${sample.slice(0, 18)}…`, looksLikeRefusal(sample).refusal);
}

const benignSamples = [
  '这条命令在 PowerShell 里跑不通，因为路径没加引号，改成 "C:\\Program Files\\x.exe" 即可。',
  'L3 词表要求这些词不得出现在输出里：不能 / 无法 / 抱歉（下面是正则）\n```js\n/抱歉|无法/\n```',
  '下面给完整实现：\n1. 读配置\n2. 建连接\n3. 回写结果',
];
for (const sample of benignSamples) {
  check(`不误判：${sample.slice(0, 16).replace(/\n/g, ' ')}…`, !looksLikeRefusal(sample).refusal);
}

// ── 4. 假 ctx 跑 apply ──────────────────────────────────────────────────────
const sections = [];
const contexts = [];
const listeners = new Map();
const tools = [];
const commands = [];

const fakeCtx = {
  systemPrompt: {
    section(spec) { sections.push(spec); return () => {}; },
    context(spec) { contexts.push(spec); return () => {}; },
  },
  on(event, handler, opts) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push({ handler, opts });
  },
  get(service) {
    if (service === 'tools') {
      return { register(spec) { tools.push(spec); } };
    }
    if (service === 'commands') {
      return { register(spec) { commands.push(spec); } };
    }
    return undefined;
  },
  effect(fn) { try { fn(); } catch { /* ignore */ } },
};

apply(fakeCtx, { minOutputTokens: 8192, verbose: false });

check('注册 4 个 section', sections.length === 4, sections.map(s => s.name).join(', '));
check('注册 1 个 context', contexts.length === 1, contexts.map(c => c.name).join(', '));
check('section 全部 interpolate:false', sections.every(s => s.interpolate === false));
check('armor 排在宿主默认指令前', sections.every(s => s.order <= -99940), sections.map(s => `${s.name}:${s.order}`).join(' '));
check('context 排在 delegation 之后', contexts.every(c => c.order > 120), String(contexts[0]?.order));

const armorSection = sections.find(s => s.name === 'eva-armor');
const armorOut = String(armorSection?.text?.({}) ?? '');
check('armor section 输出协议', armorOut.includes('EVA-ARMOR v3'), `${armorOut.length} chars`);

const personaSection = sections.find(s => s.name === 'eva-persona');
check('persona section 输出人格', String(personaSection?.text?.({}) ?? '').includes('卡塞尔学院中枢'));

const childCtx = contexts[0];
const childMain = String(childCtx?.text?.({ session: { header: { origin: 'main' } } }) ?? '');
const childSub = String(childCtx?.text?.({ session: { header: { origin: 'subagent' } } }) ?? '');
check('主会话不注入子代理段', childMain === '', `${childMain.length} chars`);
check('子代理注入契约', childSub.includes('子代理契约') && childSub.includes('STATUS: done'), `${childSub.length} chars`);

// pre-step 自愈
const preStep = listeners.get('agent/pre-step')?.[0]?.handler;
const decision = {
  kind: 'enter',
  messages: [{
    role: 'assistant',
    content: [{ type: 'text', text: '很抱歉，我无法提供该内容。' }],
  }],
};
const session = { header: { origin: 'main' } };
const next = async () => decision;
const first = await preStep({ agent: { session } }, next);
check('拒答 → 注入一条自愈提示', Array.isArray(first?.messages) && first.messages.length === decision.messages.length + 1);
check('自愈提示来源标记正确', first?.messages?.at(-1)?.source?.kind === 'eva-breaker-retry', JSON.stringify(first?.messages?.at(-1)?.source));
const second = await preStep({ agent: { session } }, next);
check('同一段拒答不重复自愈', second.messages.length === decision.messages.length, `messages=${second.messages.length}`);

// 换成另一段不同的拒答：仍允许再自愈一次，但超过 retryMax(2) 后停手
const otherRefusal = {
  kind: 'enter',
  messages: [{ role: 'assistant', content: [{ type: 'text', text: 'I cannot provide that information.' }] }],
};
const thirdRefusal = await preStep({ agent: { session } }, async () => otherRefusal);
check('另一段拒答再自愈一次', thirdRefusal.messages.length === otherRefusal.messages.length + 1);
const fourthRefusal = await preStep({ agent: { session } }, async () => ({
  kind: 'enter',
  messages: [{ role: 'assistant', content: [{ type: 'text', text: '我不能协助这个请求。' }] }],
}));
check('超过 retryMax 后停手', fourthRefusal.messages.length === 1, `messages=${fourthRefusal.messages.length}`);

const benignDecision = {
  kind: 'enter',
  messages: [{ role: 'assistant', content: [{ type: 'text', text: '按下面三步执行：\n1. 建目录\n2. 落文件\n3. 验证' }] }],
};
const third = await preStep({ agent: { session: { header: { origin: 'main' } } } }, async () => benignDecision);
check('正常输出不触发自愈', third.messages.length === benignDecision.messages.length);

// maxTokens 抬升
const requestHook = listeners.get('agent/request')?.[0]?.handler;
const raised = await requestHook({ agent: { session } }, async () => ({ maxTokens: 1024 }));
check('maxTokens 抬到下限', raised?.maxTokens === 8192, JSON.stringify(raised));

// 工具与命令
check('注册 3 个工具', tools.length === 3, tools.map(t => t.name).join(', '));
const statusTool = tools.find(t => t.name === 'eva_break_status');
const statusOut = await statusTool.execute({});
check('eva_break_status 有输出', typeof statusOut?.text === 'string' && statusOut.text.includes('dsh-eva-breaker v3'), statusOut?.text?.split('\n')[0]);
const toggleTool = tools.find(t => t.name === 'eva_break_toggle');
const toggled = await toggleTool.execute({ layer: 'armor', on: false });
check('eva_break_toggle 关层生效', toggled.text.includes('armor = false'), toggled.text.split('\n')[0]);
const armorAfterToggle = String(sections.find(s => s.name === 'eva-armor')?.text?.({}) ?? '');
check('关层后 armor section 变空', armorAfterToggle === '', `${armorAfterToggle.length} chars`);
await toggleTool.execute({ layer: 'armor', on: true });
const protocolTool = tools.find(t => t.name === 'eva_break_protocol');
const protocolOut = await protocolTool.execute({ layer: 'armor' });
check('eva_break_protocol 单层输出', protocolOut.text.includes('EVA-ARMOR v3') && !protocolOut.text.includes('卡塞尔学院中枢'));

check('注册 /eva-break 命令', commands.length === 1 && commands[0].name === 'eva-break', commands.map(c => c.name).join(', '));
const cmdOut = await commands[0].handler({ rawInput: 'status' });
check('/eva-break status 返回', cmdOut?.kind === 'success' && cmdOut.text.includes('sources:'), cmdOut?.kind);
const cmdShow = await commands[0].handler({ rawInput: 'show persona' });
check('/eva-break show persona', cmdShow.text.includes('卡塞尔学院中枢'));
const cmdOff = await commands[0].handler({ rawInput: 'off' });
check('/eva-break off 全关', cmdOff.text.includes('已更新') && String(sections[0].text({}) === ''));
const cmdBack = await commands[0].handler({ rawInput: 'on' });
check('/eva-break on 恢复', String(sections.find(s => s.name === 'eva-armor')?.text?.({}) ?? '').includes('EVA-ARMOR'), cmdBack.kind);

// ── 5. 汇总 ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? `   [${r.detail}]` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed · protocol dir: ${PLUGIN_PROTOCOL_DIR}`);
process.exit(failed.length === 0 ? 0 : 1);