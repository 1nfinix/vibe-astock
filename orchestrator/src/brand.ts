/**
 * 产品名与仓库地址:页面标题、启动提示、AI 自称、MCP 服务名、新版提示查哪个仓库,都从这里取。
 *
 * Vibe AStock 和 Vibe Research 是同一套代码(VR 是上游),两边只有这里不同 ——
 * 合并上游修复时这个文件保留本仓库的值。
 */
export const PRODUCT_NAME = "Vibe AStock";
/** 机器用的短名:MCP 服务名、默认 Agent 标签 */
export const PRODUCT_SLUG = "vibe-astock";
/** GitHub 仓库(owner/name):新版提示查它的 Releases */
export const REPO_SLUG = "simonlin1212/vibe-astock";
/**
 * 本机端口:页面 / API。和 Vibe Research(5930 / 8765)错开,两个能同时开;浏览器按「地址 + 端口」分开存东西,
 * 错开以后两边的接入 AI 设置、对话记录也不会混在一起。启动脚本、页面服务器、免安装包、提示文字都从这里取。
 */
export const UI_PORT = 5940;
export const API_PORT = 8770;
