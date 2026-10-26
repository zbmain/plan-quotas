import type { Metric } from "./types";

/** Normalize provider window spelling for comparison without altering stored data. */
function normalizedWindow(window?: string | null): string {
  return (window ?? "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

/** Identify a provider-named session or a confirmed five-hour quota window. */
function isShortWindow(window?: string | null): boolean {
  const key = normalizedWindow(window).replace(/\s/g, "");
  return [
    "session",
    "5h",
    "5hour",
    "5hours",
    "300m",
    "300min",
    "300mins",
    "300minute",
    "300minutes",
    "5小时",
    "300分钟",
  ].includes(key);
}

/** Identify weekly cycles using provider-reported week or seven-day aliases. */
function isLongWindow(window?: string | null): boolean {
  const key = normalizedWindow(window).replace(/\s/g, "");
  return [
    "week",
    "weeks",
    "weekly",
    "7d",
    "7day",
    "7days",
    "7天",
    "1week",
    "168hour",
    "168hours",
    "10080m",
    "10080minute",
    "10080minutes",
    "10080分钟",
    "604800s",
    "604800seconds",
    "周",
    "每周",
  ].includes(key);
}

/** Parse a Kimi window in either its current duration format or a legacy label. */
function kimiWindowKind(metric: Metric): "short" | "long" | null {
  const key = normalizedWindow(metric.window).replace(/\s/g, "");
  if (isShortWindow(metric.window) || key === "300timeunitminute")
    return "short";
  if (
    isLongWindow(metric.window) ||
    key === "10080timeunitminute" ||
    (metric.id === "coding" && key === "套餐周期")
  )
    return "long";
  return null;
}

/** Present Kimi's provider quota counters as percentages while preserving stored values. */
export function kimiDisplayMetric(metric: Metric, provider: string): Metric {
  if (provider !== "kimi" || metric.kind !== "quota") return metric;
  const cycle = kimiWindowKind(metric);
  if (!cycle) return metric;

  let usedPercent = metric.used_percent ?? null;
  if (
    usedPercent == null &&
    metric.used != null &&
    metric.limit != null &&
    metric.limit > 0
  )
    usedPercent = (metric.used / metric.limit) * 100;
  if (
    usedPercent == null &&
    metric.remaining != null &&
    metric.limit != null &&
    metric.limit > 0
  )
    usedPercent = ((metric.limit - metric.remaining) / metric.limit) * 100;

  return {
    ...metric,
    label: cycle === "short" ? "5 小时用量" : "7 天用量",
    window: cycle === "short" ? "5h" : "7d",
    unit: "%",
    used: usedPercent,
    limit: usedPercent == null ? null : 100,
    remaining: null,
    used_percent: usedPercent,
  };
}

/** Keep known model-specific quota names distinct while translating their cadence. */
function modelSpecificLabel(label: string): string | null {
  const model = label.match(/\b(Sonnet|Opus|Gemini|DeepSeek)\b/i)?.[1];
  if (!model) return null;
  const normalizedModel: Record<string, string> = {
    sonnet: "Sonnet",
    opus: "Opus",
    gemini: "Gemini",
    deepseek: "DeepSeek",
  };
  const modelName = normalizedModel[model.toLocaleLowerCase("en-US")];
  if (/(?:\b7\s*days?\b|7\s*天|\bweekly\b|\bweek\b)/i.test(label))
    return `${modelName} 长周期`;
  if (/\b(5\s*h(?:ours?)?|300\s*(?:m|minutes?))\b/i.test(label))
    return `${modelName} 短周期`;
  const remainder = label.replace(new RegExp(model, "i"), "").trim();
  if (!remainder) return modelName;
  if (/^(quota|usage|limit)$/i.test(remainder)) return `${modelName} 额度`;
  const localizedRemainder = remainder
    .replace(/\bquota\b/gi, "额度")
    .replace(/\busage\b/gi, "用量")
    .replace(/\blimit\b/gi, "限额");
  return `${modelName} ${localizedRemainder}`;
}

/** Translate metric names using their provider-reported windows for consistent Chinese labels. */
export function metricDisplayLabel(metric: Metric): string {
  const source = metric.label.trim();
  if (source === "5 小时用量" || source === "7 天用量") return source;
  if (metricGroup(metric) === "tool") {
    const toolKey = source
      .toLocaleLowerCase("en-US")
      .replace(/[._-]+/g, " ")
      .trim();
    const toolLabels: Record<string, string> = {
      mcp: "MCP 调用次数",
      "mcp calls": "MCP 调用次数",
      "mcp requests": "MCP 调用次数",
      "web search": "联网搜索次数",
      "web searches": "联网搜索次数",
      "web reader": "网页读取次数",
      "image generation": "图像生成次数",
      "image generations": "图像生成次数",
      "image analysis": "图像分析次数",
    };
    if (toolLabels[toolKey]) return toolLabels[toolKey];
    return source
      .replace(/\bweb\b/gi, "网页")
      .replace(/\bsearch(es)?\b/gi, "搜索")
      .replace(/\breader\b/gi, "读取")
      .replace(/\bimage(s)?\b/gi, "图像")
      .replace(/\bgeneration(s)?\b/gi, "生成")
      .replace(/\banalysis\b/gi, "分析")
      .replace(/\bcalls?\b/gi, "调用次数")
      .replace(/\brequests?\b/gi, "调用次数");
  }

  const modelLabel = modelSpecificLabel(source);
  if (modelLabel) return modelLabel;
  if (metric.kind === "quota" && isShortWindow(metric.window)) return "短周期";
  if (metric.kind === "quota" && isLongWindow(metric.window)) return "长周期";

  const window = normalizedWindow(metric.window);
  const genericQuota =
    /^(?:glm\s+)?(?:coding\s+plan|quota|额度|套餐(?:额度)?)$/i.test(source);
  if (genericQuota && ["monthly", "month"].includes(window)) return "月度额度";

  const key = source
    .toLocaleLowerCase("en-US")
    .replace(/[._-]+/g, " ")
    .trim();
  const known: Record<string, string> = {
    "coding plan": "套餐额度",
    "glm coding plan": "套餐额度",
    quota: "套餐额度",
    周额度: "长周期",
    "weekly quota": "长周期",
    长周期: "长周期",
    短周期: "短周期",
    "session quota": "短周期",
    "5 小时": "短周期",
    "7 天": "长周期",
    每周: "长周期",
    每月: "月度额度",
    "cursor models": "Cursor 模型额度",
    "other models": "其他模型额度",
    主要额度: "主要额度",
    次要额度: "次要额度",
    速率限制: "调用额度",
    usage: "用量",
    "model quota": "模型额度",
    overall: "总用量",
  };
  if (known[key]) return known[key];

  return source
    .replace(/\bCoding\s+Plan\b/gi, "套餐")
    .replace(/\busage\b/gi, "用量")
    .replace(/\bquota\b/gi, "额度")
    .replace(/\brequests?\b/gi, "调用次数")
    .replace(/\bsearch(es)?\b/gi, "搜索")
    .replace(/\bweb\b/gi, "网页")
    .replace(/\breader\b/gi, "读取")
    .replace(/\bimages?\b/gi, "图像")
    .replace(/\brate\s+limit\b/gi, "调用额度")
    .replace(/\bother\b/gi, "其他")
    .replace(/\btotal\b/gi, "总")
    .replace(/\bmodels?\b/gi, "模型")
    .replace(/\bauto\b/gi, "自动")
    .replace(/\bpercent(age)?\b/gi, "比例")
    .replace(/\bspend(ing)?\b/gi, "消费")
    .replace(/\bplan\b/gi, "套餐")
    .replace(/\bapi\b/gi, "API")
    .replace(/\bgpt\b/gi, "GPT");
}

/** Translate common provider cadence aliases and durations without guessing unknown periods. */
export function metricWindowLabel(window?: string | null): string {
  if (!window) return "";
  const source = window.trim();
  const key = normalizedWindow(source);
  const modelWeek = source.match(/^(Sonnet|Opus)\s+7\s*天$/i);
  if (modelWeek)
    return `${modelWeek[1][0].toUpperCase()}${modelWeek[1].slice(1).toLowerCase()} 每周`;
  if (key === "session") return "短周期";
  if (
    /^(5\s*h|5\s*hours?|300\s*(m|min|mins|minutes?)|5\s*小时|300\s*分钟)$/i.test(
      source,
    )
  )
    return "5 小时";
  if (/^(week|weeks|weekly|每周|周)$/i.test(key)) return "每周";
  if (isLongWindow(source) && !/^(7\s*d|7\s*days?|7\s*天)$/i.test(source))
    return "每周";
  if (/^(7\s*d|7\s*days?|7\s*天)$/i.test(source)) return "7 天";
  if (/^(month|monthly|每月)$/i.test(key)) return "每月";
  if (/^(daily|day)$/i.test(key)) return "每日";
  if (/^(yearly|annual|annually|year)$/i.test(key)) return "每年";
  if (/^(billing cycle|账单周期)$/i.test(key)) return "账单周期";
  if (/^(payg|pay as you go)$/i.test(key)) return "按量付费";
  if (/^(primary window|主要额度)$/i.test(key)) return "主要额度";
  if (/^(secondary window|次要额度)$/i.test(key)) return "次要额度";
  if (/^(model quota|模型额度)$/i.test(key)) return "模型额度";
  if (/^(套餐周期|速率窗口|账单月)$/i.test(source)) return source;
  if (/^quota\s*\d*$/i.test(key)) return "其他周期";

  const compact = key
    .replace(/\s/g, "")
    .match(
      /^(\d+(?:\.\d+)?)(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?|mo|months?)$/i,
    );
  if (compact) {
    const amount = compact[1];
    const unit = compact[2].toLocaleLowerCase("en-US");
    if (/^(s|sec|secs|seconds?)$/.test(unit)) return `${amount} 秒`;
    if (/^(m|min|mins|minutes?)$/.test(unit)) return `${amount} 分钟`;
    if (/^(h|hr|hrs|hours?)$/.test(unit)) return `${amount} 小时`;
    if (/^(d|days?)$/.test(unit)) return `${amount} 天`;
    if (/^(w|weeks?)$/.test(unit)) return `${amount} 周`;
    return `${amount} 个月`;
  }

  if (/^[\u3400-\u9fff\p{P}\p{N}\s·%]+$/u.test(source)) return source;
  if (/^(sonnet|opus|gemini|deepseek)\b/i.test(source)) return source;
  return "自定义周期";
}

/** Map provider units to Chinese while preserving percentages and currency codes. */
export function metricUnitLabel(unit?: string | null): string {
  if (!unit) return "";
  const key = unit.trim().toLocaleLowerCase("en-US");
  const known: Record<string, string> = {
    "%": "%",
    次: "次",
    次数: "次",
    request: "次",
    requests: "次",
    calls: "次",
    call: "次",
    tokens: "令牌",
    token: "令牌",
    quota: "额度",
    cny: "CNY",
    usd: "USD",
    rmb: "CNY",
    images: "张",
    image: "张",
  };
  return known[key] ?? (/^[\u3400-\u9fff%]+$/u.test(unit) ? unit : "单位未知");
}

/** Group actual tool-call quotas without treating generic request counters as MCP usage. */
export function metricGroup(
  metric: Metric,
): "periodic" | "tool" | "balance" | "other" {
  if (metric.kind === "balance" || metric.kind === "cost") return "balance";
  const text = `${metric.id} ${metric.label}`.toLocaleLowerCase("en-US");
  const hasProviderToolId =
    /(?:^|[^a-z0-9])(?:mcp|time_limit|web_reader|zread|search_prime|image_generation)(?:$|[^a-z0-9])/.test(
      text,
    );
  const hasChineseToolLabel =
    /MCP|联网搜索|网页(?:阅读|读取)|仓库检索|图像(?:生成|分析)|搜索次数/i.test(
      text,
    );
  if (hasProviderToolId || hasChineseToolLabel) return "tool";
  if (metric.kind === "quota") return "periodic";
  return "other";
}
