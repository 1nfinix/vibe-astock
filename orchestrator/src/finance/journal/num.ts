/**
 * 交易日志的数字工具。算法移植自 Vibe AStock v2.0.0(Python),对账时要逐项一致,所以舍入照 Python 的 round。
 */

/**
 * 和 Python `round(x, n)` 同一结果:按 double 的**精确**十进制值舍入,恰好一半时取偶数。
 * ⚠️ `Number(x.toFixed(n))` 恰好一半时往大的进(12.125 → 12.13,Python 是 12.12)。
 *    钱数是分的整数倍除出来的,恰好一半(x.125 / x.375 …)真会出现,对账就差一分。
 * toFixed(100) 给出 double 的精确十进制展开(规范要求),在字符串上进位,不再经过浮点运算。
 */
export function pyRound(x: number, n: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const neg = x < 0;
  const [ip, fp = ""] = Math.abs(x).toFixed(100).split(".");
  const keep = fp.slice(0, n), rest = fp.slice(n);
  let digits = ip! + keep;
  const first = rest[0] ?? "0";
  const tail = rest.slice(1);
  const odd = Number(digits[digits.length - 1]) % 2 === 1;
  const up = first > "5" || (first === "5" && (/[1-9]/.test(tail) || odd));
  if (up) {
    const arr = digits.split("");
    let i = arr.length - 1;
    for (; i >= 0; i--) {
      if (arr[i] === "9") { arr[i] = "0"; continue; }
      arr[i] = String(Number(arr[i]) + 1);
      break;
    }
    digits = (i < 0 ? "1" : "") + arr.join("");
  }
  const intLen = digits.length - n;
  const v = Number(n > 0 ? `${digits.slice(0, intLen)}.${digits.slice(intLen)}` : digits);
  return neg && v !== 0 ? -v : v;
}

/**
 * 求和用 Neumaier 补偿:Python 3.12 起内置 sum() 对浮点就是这么加的,statistics.mean 更是按精确分数求和。
 * 普通累加几十笔之后会差几个末位,碰上舍入边界对账就差一分。
 */
export function sum(vals: readonly number[]): number {
  let s = 0, c = 0;
  for (const v of vals) {
    const t = s + v;
    c += Math.abs(s) >= Math.abs(v) ? (s - t) + v : (v - t) + s;
    s = t;
  }
  return s + c;
}

export function mean(vals: readonly number[]): number {
  return sum(vals) / vals.length;
}

export function median(vals: readonly number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** 真实存在的日历日。先判 NaN:`2025-13-01` 的 Invalid Date 调 toISOString 会抛错 */
export const realDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
/** 两个日历日之间隔几天(b − a) */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
