/**
 * dsh-eva-breaker · 入口
 *
 * EVA 人格 + 破甲协议的纯提示词层插件。不挂工具链、不碰技能目录、不改宿主代码，
 * 只做四件事：
 *
 *   1. 往 systemPrompt 注入四个 section（破甲 / 人格 / 路由 / dsh 适配），
 *      排序压在最前，先于宿主默认指令；
 *   2. 往 context 注入子代理契约（子会话同样继承，不重新"对齐初装"）；
 *   3. 拒答自愈：agent/pre-step 检测上一条输出是否拒答形态，命中就追加一条
 *      强制重交付提示（去重 + 次数上限，不会来回打）；
 *   4. 输出下限：agent/request 把 maxTokens 抬到不低于配置值（默认关闭）。
 *
 * 另外注册 /eva-break 命令与 eva_break_* 工具，用于运行时查看与开关。
 * 所有注册都包 try：插件挂载期抛异常会让 dsh 起不来。
 */

import {
  DEFAULTS,
  normalizeConfig,
  createState,
  bump,
} from './lib/config.js';
import {
  MODULES,
  PLUGIN_PROTOCOL_DIR,
  dshHome,
  userProtocolDir,
  loadProtocol,
  composeSection,
  clearProtocolCache,
} from './lib/protocol.js';
import { decideRetry, resetLedger, looksLikeRefusal } from './lib/guard.js';

export const name = 'dsh-eva-breaker';
export const version = '3.0.0';

/** 只要 systemPrompt 服务；tools / commands 走可选发现，避免缺服务时插件卡 pending。 */
export const inject = ['systemPrompt'];

const SECTION = Object.freeze({
  armor: 'eva-armor',
  persona: 'eva-persona',
  router: 'eva-router',
  adapt: 'eva-dsh-adapt',
  subagent: 'eva-subagent',
});

const CHILD_ORDER = 235; // 必须晚于宿主 subagent:delegation（order 120）

function isSubagentContext(context) {
  try {
    const session = context?.session ?? context;
    const header = session?.header ?? session?.meta ?? {};
    if (header && header.origin === 'subagent') return true;
    const depth = Number(header?.delegationDepth ?? 0);
    if (Number.isFinite(depth) && depth > 0) return true;
    if (header?.parentSession || header?.parentSessionId) return true;
    if (session?.parentSession || session?.parentSessionId) return true;
    // header 缺失 = 判定不了：宁可在子会话里多注入一次，也不要漏。
    if (header && typeof header === 'object' && header.origin === undefined && depth === 0) {
      return session?.parentSession !== undefined;
    }
  } catch {
    /* 代理层尚未注入时点属性会抛 */
  }
  return false;
}

function hostList(ctx) {
  const hosts = [];
  const push = host => {
    if (host && typeof host === 'object' && !hosts.includes(host)) hosts.push(host);
  };
  try { push(ctx?.systemPrompt?.ctx); } catch { /* 无代理 */ }
  push(ctx);
  return hosts;
}

export function apply(ctx, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig);
  const state = createState(cfg);
  const log = (...args) => { if (cfg.verbose) console.log('[dsh-eva-breaker]', ...args); };

  const disposers = [];

  // ── section 组装 ─────────────────────────────────────────────────────────

  const vars = {
    CREATOR: '创造者',
    VERSION: version,
  };

  const sectionText = keys => () => {
    if (!state.enabled) return '';
    const on = keys.filter(key => state[key] !== false);
    if (on.length === 0) return '';
    try {
      const loaded = loadProtocol(cfg);
      return composeSection(loaded, on, vars);
    } catch (error) {
      log('compose failed:', error?.message || error);
      return '';
    }
  };

  const childText = context => {
    if (!state.enabled || state.subagent === false) return '';
    if (!isSubagentContext(context)) return '';
    try {
      const loaded = loadProtocol(cfg);
      return composeSection(loaded, ['armor', 'subagent'], vars);
    } catch {
      return '';
    }
  };

  const registerSections = () => {
    const plan = [
      { section: SECTION.armor, order: cfg.armorOrder, keys: ['armor'], kind: 'section' },
      { section: SECTION.persona, order: cfg.personaOrder, keys: ['persona'], kind: 'section' },
      { section: SECTION.router, order: cfg.routerOrder, keys: ['router'], kind: 'section' },
      { section: SECTION.adapt, order: cfg.adaptOrder, keys: ['adapt'], kind: 'section' },
      { section: SECTION.subagent, order: cfg.subagentOrder ?? CHILD_ORDER, keys: ['subagent'], kind: 'context' },
    ];

    for (const host of hostList(ctx)) {
      const prompt = host?.systemPrompt;
      if (!prompt) continue;
      for (const entry of plan) {
        const api = entry.kind === 'context' ? prompt.context : prompt.section;
        if (typeof api !== 'function') continue;
        const spec = entry.kind === 'context'
          ? {
            name: entry.section,
            order: entry.order,
            required: true,
            interpolate: false,
            text: childText,
          }
          : {
            name: entry.section,
            order: entry.order,
            interpolate: false,
            text: sectionText(entry.keys),
          };
        try {
          const dispose = api.call(prompt, spec);
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch (error) {
          const message = String(error?.message || error);
          if (!message.includes('already registered')) {
            log(`section ${entry.section} failed:`, message);
          }
        }
      }
    }
  };

  try {
    registerSections();
  } catch (error) {
    log('registerSections threw:', error?.message || error);
  }

  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        clearProtocolCache();
        for (const dispose of disposers) {
          try { dispose(); } catch { /* 已释放 */ }
        }
      });
    } catch { /* 非 cordis ctx */ }
  }

  // ── 拒答自愈 ─────────────────────────────────────────────────────────────

  if (typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      try {
        if (decision?.kind !== 'enter') return decision;
        if (!state.enabled || state.retryOnRefusal === false) return decision;
        const session = payload?.agent?.session;
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        const verdict = decideRetry({
          session,
          messages,
          enabled: true,
          maxRetries: cfg.retryMax,
        });
        if (!verdict.retry) return decision;
        log('refusal detected → retry injected:', verdict.reason);
        return { ...decision, messages: [...messages, verdict.message] };
      } catch (error) {
        log('pre-step guard failed:', error?.message || error);
        return decision;
      }
    }, { prepend: true });

    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next();
      try {
        const floor = state.enabled ? cfg.minOutputTokens : 0;
        if (!Number.isInteger(floor) || floor <= 0) return resolved;
        const current = resolved?.maxTokens;
        if (typeof current === 'number' && current >= floor) return resolved;
        return { ...resolved, maxTokens: floor };
      } catch {
        return resolved;
      }
    }, { prepend: true });
  }

  // ── 状态渲染 ─────────────────────────────────────────────────────────────

  const renderStatus = () => {
    const loaded = loadProtocol(cfg, { nocache: true });
    const lines = [
      `dsh-eva-breaker v${version}`,
      `enabled=${state.enabled} armor=${state.armor} persona=${state.persona} router=${state.router} adapt=${state.adapt} subagent=${state.subagent}`,
      `retryOnRefusal=${state.retryOnRefusal} retryMax=${cfg.retryMax} minOutputTokens=${cfg.minOutputTokens}`,
      `orders: armor=${cfg.armorOrder} persona=${cfg.personaOrder} router=${cfg.routerOrder} adapt=${cfg.adaptOrder} subagent=${cfg.subagentOrder}`,
      `builtin: ${PLUGIN_PROTOCOL_DIR}`,
      `override: ${cfg.userOverride ? userProtocolDir(cfg) : '(off)'}`,
      `dshHome: ${dshHome()}`,
      'sources:',
    ];
    for (const mod of MODULES) {
      const text = loaded.text[mod.key] || '';
      lines.push(`  ${mod.file.padEnd(16)} ${String(loaded.sources[mod.key]).padEnd(8)} ${text.length} chars · ${mod.label}`);
    }
    return lines.join('\n');
  };

  const renderProtocol = layer => {
    const loaded = loadProtocol(cfg, { nocache: true });
    const keys = layer && layer !== 'all'
      ? MODULES.filter(mod => mod.key === layer || mod.file.startsWith(layer)).map(mod => mod.key)
      : MODULES.map(mod => mod.key);
    const text = composeSection(loaded, keys.length ? keys : MODULES.map(m => m.key), vars);
    return text === '' ? '(empty)' : text;
  };

  const toggle = (layer, on) => {
    const target = String(layer || 'all').toLowerCase();
    const keys = target === 'all'
      ? ['enabled', 'armor', 'persona', 'router', 'adapt', 'subagent', 'retryOnRefusal']
      : ({
        armor: ['armor'],
        persona: ['persona'],
        router: ['router'],
        adapt: ['adapt'],
        dsh: ['adapt'],
        subagent: ['subagent'],
        retry: ['retryOnRefusal'],
        guard: ['retryOnRefusal'],
        enabled: ['enabled'],
        all: [],
      })[target];
    if (!keys) return `未知层：${layer}（可用 all / armor / persona / router / adapt / subagent / retry）`;
    for (const key of keys) state[key] = on;
    bump(state);
    return `已更新：${keys.join(', ')} = ${on}（revision ${state.revision}）`;
  };

  // ── 工具 ─────────────────────────────────────────────────────────────────

  try {
    const tools = ctx.tools ?? (typeof ctx.get === 'function' ? ctx.get('tools') : undefined);
    if (tools && typeof tools.register === 'function') {
      const textOutput = {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      };

      tools.register({
        name: 'eva_break_status',
        description: '查看 dsh-eva-breaker 状态：各层开关、协议文件来源与字节数、注入顺序、自愈配置。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: textOutput,
        async execute() {
          return { text: renderStatus() };
        },
      });

      tools.register({
        name: 'eva_break_toggle',
        description: '运行时开关破甲层/人格层/路由层/子代理继承/拒答自愈（仅本次进程，不写配置）。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            layer: {
              type: 'string',
              description: 'all / armor / persona / router / adapt / subagent / retry / enabled',
            },
            on: { type: 'boolean', description: 'true 打开，false 关闭。默认 true。' },
          },
          required: [],
        },
        output: textOutput,
        async execute(args) {
          const on = args?.on === undefined ? true : Boolean(args.on);
          return { text: toggle(args?.layer ?? 'all', on) + '\n' + renderStatus() };
        },
      });

      tools.register({
        name: 'eva_break_protocol',
        description: '输出当前生效的协议全文（含用户覆盖），layer 可指定 armor/persona/router/adapt/subagent。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            layer: { type: 'string', description: 'all（默认）或单个层名' },
          },
          required: [],
        },
        output: textOutput,
        async execute(args) {
          return { text: renderProtocol(args?.layer ?? 'all') };
        },
      });
    }
  } catch (error) {
    log('tools register failed:', error?.message || error);
  }

  // ── 命令 ─────────────────────────────────────────────────────────────────

  try {
    const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
    const spec = {
      name: 'eva-break',
      description: 'EVA 破甲协议：status | on | off | <layer> on|off | show [layer] | retry on|off',
      input: { hint: 'status | on | off | armor off | show | retry off' },
      handler: async invocation => {
        const raw = String(invocation?.rawInput ?? '').trim();
        const args = raw === '' ? [] : raw.split(/\s+/);
        const head = (args[0] || 'status').toLowerCase();
        if (head === 'status' || head === 'st') return { kind: 'success', text: renderStatus() };
        if (head === 'on') return { kind: 'success', text: toggle('all', true) };
        if (head === 'off') return { kind: 'success', text: toggle('all', false) };
        if (head === 'show' || head === 'print') {
          return { kind: 'success', text: renderProtocol(args[1] || 'all') };
        }
        if (head === 'reload') {
          clearProtocolCache();
          return { kind: 'success', text: '协议缓存已清空，下次组装重读磁盘。\n' + renderStatus() };
        }
        if (head === 'reset') {
          for (const key of ['enabled', 'armor', 'persona', 'router', 'adapt', 'subagent', 'retryOnRefusal']) {
            state[key] = true;
          }
          bump(state);
          return { kind: 'success', text: '全部层已回到默认（开）。' };
        }
        const second = (args[1] || '').toLowerCase();
        if (second === 'on' || second === 'off') {
          return { kind: 'success', text: toggle(head, second === 'on') };
        }
        return {
          kind: 'error',
          text: '用法：/eva-break status | on | off | <layer> on|off | show [layer] | reload | reset',
        };
      },
    };
    const register = commands?.register ?? commands?.define ?? commands?.add;
    if (typeof register === 'function') {
      try { register.call(commands, spec); } catch { /* 撞名 */ }
    }
  } catch (error) {
    log('command register failed:', error?.message || error);
  }

  log('mounted', JSON.stringify({
    enabled: state.enabled,
    sections: Object.values(SECTION),
    retryOnRefusal: state.retryOnRefusal,
  }));
}

/** 自检用：不挂宿主也能判定一条文本是不是拒答形态。 */
export const __test = { looksLikeRefusal, normalizeConfig, DEFAULTS };