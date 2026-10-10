/**
 * 界面上的产品名与仓库地址(与 orchestrator/src/brand.ts 同一组值)。
 * Vibe AStock 和 Vibe Research 是同一套代码(VR 是上游),两边只有这里不同 —— 合并上游时保留本仓库的值。
 */
export const PRODUCT_NAME = "Vibe AStock";
/** 侧栏左上角的字标:前半段常规色、后半段主题色 */
export const BRAND_MARK = ["Vibe-", "AStock"] as const;
/** 侧栏字标下面那行小字 */
export const PRODUCT_TAGLINE = "A 股短线复盘与跟踪工作台";
export const REPO_SLUG = "simonlin1212/vibe-astock";
export const REPO_URL = `https://github.com/${REPO_SLUG}`;
/**
 * 本机端口:页面 / API。和 Vibe Research(5930 / 8765)错开,两个能同时开;浏览器按「地址 + 端口」分开存东西,
 * 错开以后两边的接入 AI 设置、对话记录也不会混在一起。页面服务器(vite.config.ts)和设置页的提示从这里取,和 orchestrator/src/brand.ts 同值。
 */
export const UI_PORT = 5940;
export const API_PORT = 8770;
