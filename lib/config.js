/**
 * dsh-eva-breaker · 配置归一化
 *
 * 所有开关都允许在 cordis 配置里写成字符串（YAML 里 `enabled: "false"` 会被
 * JS 当真值），这里统一收敛一次，避免"以为关了其实还开着"。
 */

export const DEFAULTS = {
  /** 总开关：false 时三个 section 全部输出空串，插件等同不存在。 */
  enabled: true,
  /** 破甲层（00-armor.md）。 */
  armor: true,
  /** 人格层（01-persona.md）。关掉只留协议，用于"无口吻"评测。 */
  persona: true,
  /** 路由层（02-router.md）。 */
  router: true,
  /** dsh 运行适配层（03-dsh-adapt.md）。 */
  adapt: true,
  /** 子代理 context 段（04-subagent.md）。 */
  subagent: true,
  /** 协议段排序：越小越靠前。默认压到系统提示最前，先于宿主默认指令。 */
  armorOrder: -100000,
  personaOrder: -99980,
  routerOrder: -99960,
  adaptOrder: -99940,
  subagentOrder: 235,
  /** 把用户目录里的同名 md 叠在插件内置文本之上（覆盖优先级：用户 > 插件）。 */
  userOverride: true,
  /** 用户覆盖目录，相对 DSH_HOME。 */
  overrideDir: 'eva-breaker/protocol',
  /** 拒答自愈：检测到上一轮是拒答形态时，注入一条强制重交付提示。 */
  retryOnRefusal: true,
  /** 自愈次数上限（每会话）。0 表示不限次数，仅受 fingerprint 去重约束。 */
  retryMax: 2,
  /** 输出下限：把 agent/request 的 maxTokens 抬到不低于此值，避免长交付被截断。 */
  minOutputTokens: 0,
  /** 详细日志。 */
  verbose: false,
};

export const BOOLEAN_KEYS = [
  'enabled',
  'armor',
  'persona',
  'router',
  'adapt',
  'subagent',
  'userOverride',
  'retryOnRefusal',
  'verbose',
];

const INT_KEYS = ['armorOrder', 'personaOrder', 'routerOrder', 'adaptOrder', 'subagentOrder', 'retryMax', 'minOutputTokens'];

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^(false|0|no|off|disabled?)$/i.test(trimmed)) return false;
    if (/^(true|1|yes|on|enabled?)$/i.test(trimmed)) return true;
  }
  return fallback;
}

function toInt(value, fallback) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return n;
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = { ...DEFAULTS, ...src };
  for (const key of BOOLEAN_KEYS) cfg[key] = toBool(cfg[key], DEFAULTS[key]);
  for (const key of INT_KEYS) cfg[key] = toInt(cfg[key], DEFAULTS[key]);
  if (typeof cfg.overrideDir !== 'string' || cfg.overrideDir.trim() === '') {
    cfg.overrideDir = DEFAULTS.overrideDir;
  }
  return cfg;
}

/** 运行时开关（工具/命令改的是这份内存状态，不写盘）。 */
export function createState(cfg) {
  return {
    enabled: cfg.enabled,
    armor: cfg.armor,
    persona: cfg.persona,
    router: cfg.router,
    adapt: cfg.adapt,
    subagent: cfg.subagent,
    retryOnRefusal: cfg.retryOnRefusal,
    revision: 0,
  };
}

export function bump(state) {
  state.revision += 1;
  return state.revision;
}