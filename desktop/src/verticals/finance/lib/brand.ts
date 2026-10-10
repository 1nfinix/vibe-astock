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
