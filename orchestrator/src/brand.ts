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
