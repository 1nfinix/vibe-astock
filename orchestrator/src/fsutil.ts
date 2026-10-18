/** 文件工具:原子写入(临时文件 → fsync → 替换)、sha256、JSON 读写、追加 JSONL。*/
import { createHash } from "node:crypto";
import { spawnSync, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** O_NOFOLLOW 在 Windows 不受支持；Windows 路径由 safePath/lstat 的逐级链接检查保护。 */
export const NOFOLLOW_FLAG = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;

const WINDOWS_CHECK_ACL = String.raw`
$ErrorActionPreference = "Stop"
$file = $env:VRA_PRIVATE_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $file
if (-not $acl.AreAccessRulesProtected) { exit 3 }
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$others = @()
$self = $false
foreach ($rule in $acl.Access) {
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
    $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($ruleSid -eq $sid) { if (($rule.FileSystemRights -band $full) -eq $full) { $self = $true } }
    elseif ($others -notcontains $ruleSid) { $others += $ruleSid }
  }
}
if ($others.Count -gt 0) { Write-Output ($others -join " "); exit 4 }
if (-not $self) { exit 5 }
exit 0
`;

function windowsAclEnv(file: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, VRA_PRIVATE_FILE: path.resolve(file) };
  // A parent PowerShell 7 process exports its module search path. Windows
  // PowerShell 5.1 cannot load those Security modules; use its own defaults.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  return env;
}

type WindowsAclCheck = { secure: boolean; detail: string; others: string[] };

function windowsAclCheck(file: string): WindowsAclCheck {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_CHECK_ACL], {
    env: windowsAclEnv(file), encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  return windowsAclVerdict(result.status, result.stdout, result.error);
}

let windowsSidCache: string | null = null;

/** 从 `whoami /user /fo csv /nh` 的输出里取 SID(形如 "域\用户","S-1-5-21-…")。 */
export function parseWhoamiSid(output: string): string | null {
  const m = /"(S-1-\d+(?:-\d+)+)"$/.exec(String(output ?? "").trim());
  return m ? m[1]! : null;
}

function accountFromEnv(): string {
  const user = process.env.USERNAME ?? "";
  const domain = process.env.USERDOMAIN ?? "";
  if (!user) throw new Error("拿不到当前用户(whoami 失败且 USERNAME 为空)");
  return domain ? `${domain}\\${user}` : user;
}

/** icacls 的授权对象:优先当前进程用户的 SID(`*S-1-…`),跟 WINDOWS_CHECK_ACL 认的是同一个身份,
 *  不受 USERDOMAIN / USERNAME 环境变量影响;whoami 拿不到时才退回用户名(授错人时检查会报出来)。 */
function windowsAccount(): string {
  if (windowsSidCache) return `*${windowsSidCache}`;
  const result = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const sid = !result.error && result.status === 0 ? parseWhoamiSid(result.stdout) : null;
  if (!sid) return accountFromEnv();
  windowsSidCache = sid;
  return `*${sid}`;
}

async function windowsAccountAsync(): Promise<string> {
  if (windowsSidCache) return `*${windowsSidCache}`;
  const sid = await new Promise<string | null>(resolve => {
    execFile("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(error ? null : parseWhoamiSid(stdout)));
  });
  if (!sid) return accountFromEnv();
  windowsSidCache = sid;
  return `*${sid}`;
}

function icacls(file: string, args: string[]): void {
  const result = spawnSync("icacls.exe", [path.resolve(file), ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`无法收紧 Windows 文件权限(${result.error?.message ?? `icacls exit ${result.status}`})`);
  }
}

function icaclsAsync(file: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile("icacls.exe", [path.resolve(file), ...args], { windowsHide: true, timeout: 10_000, killSignal: "SIGKILL" },
      err => err ? reject(new Error(`无法收紧 Windows 文件权限(${err.message})`)) : resolve());
  });
}

/** 复查里列出的其他账户,交给 `icacls /remove:g` 逐个删掉授权。 */
const removeOthersArgs = (others: string[]) => ["/remove:g", ...others.map(sid => `*${sid}`)];

/** Windows 的 mode 0600 不会改变 NTFS DACL；敏感文件必须显式断开继承并只授权当前用户。
 *
 * 🔴 不用 Get-Acl/Set-Acl:Get-Acl 默认捕获全部安全节(含 SACL),Set-Acl 会原样写回,
 *    而写 SACL 需要 SeSecurityPrivilege —— 普通未提权进程没有这个特权,
 *    整个 API 会因此起不来(2026-10-14 实测:PrivilegeNotHeldException)。
 *    icacls 只动 DACL 和继承标志,不需要任何特权。
 *
 * 🔴 `/inheritance:r /grant:r` 只断继承、替换当前用户那一条,不删别的账户单独挂的授权 ——
 *    GitHub 的 Windows 测试机上新建的文件就带着(2026-10-18 CI 实测)。所以收紧后复查,
 *    复查列出的其他账户用 `/remove:g` 删掉再查一次;还不干净、或当前用户自己没有完全控制
 *    (whoami 失败时退回的用户名不对)就报错,不当成功。
 */
export function restrictPrivateFile(file: string): void {
  if (process.platform !== "win32") { fs.chmodSync(file, 0o600); return; }
  // 🔴 必须一条命令完成:先 /inheritance:r 单独执行会把 DACL 清空(继承 ACE 全没了、又没加新 ACE),
  //    连 icacls 自己都打不开文件(实测拒绝访问),第二步永远失败。先授权当前用户、再删别人,也是这个原因。
  icacls(file, ["/inheritance:r", "/grant:r", `${windowsAccount()}:F`]);
  let check = windowsAclCheck(file);
  if (!check.secure && check.others.length) {
    icacls(file, removeOthersArgs(check.others));
    check = windowsAclCheck(file);
  }
  if (!check.secure) throw new Error(`无法收紧 Windows 文件权限(${check.detail})`);
}

/** Request-path ACL setup must not block unrelated API requests on Windows. */
export async function restrictPrivateFileAsync(file: string): Promise<void> {
  if (process.platform !== "win32") { await fs.promises.chmod(file, 0o600); return; }
  await icaclsAsync(file, ["/inheritance:r", "/grant:r", `${await windowsAccountAsync()}:F`]);
  let check = await windowsAclCheckAsync(file);
  if (!check.secure && check.others.length) {
    await icaclsAsync(file, removeOthersArgs(check.others));
    check = await windowsAclCheckAsync(file);
  }
  if (!check.secure) throw new Error(`无法收紧 Windows 文件权限(${check.detail})`);
}

export function privateFilePermissions(file: string): { secure: boolean; detail: string } {
  if (process.platform !== "win32") {
    const mode = fs.statSync(file).mode & 0o777;
    return { secure: (mode & 0o077) === 0, detail: `mode ${mode.toString(8)}` };
  }
  const { secure, detail } = windowsAclCheck(file);
  return { secure, detail };
}

/** WINDOWS_CHECK_ACL 的退出码 → 结论;exit 4 时 stdout 是用空格隔开的其他账户 SID;
 *  exit 5 = 没有别人,但当前用户自己也没有完全控制(产品写的私密文件一律给当前用户完全控制)。 */
export function windowsAclVerdict(status: number | null, stdout?: string | null, error?: Error): WindowsAclCheck {
  if (error) return { secure: false, detail: `Windows ACL 检查失败:${error.message}`, others: [] };
  if (status === 0) return { secure: true, detail: "Windows ACL 已断开继承，仅当前用户 SID 可读写", others: [] };
  if (status === 3) return { secure: false, detail: "Windows ACL 仍在继承父目录权限", others: [] };
  if (status === 4) {
    const others = String(stdout ?? "").split(/\s+/).filter(s => /^S-1-\d+(?:-\d+)+$/.test(s));
    return { secure: false, detail: `Windows ACL 还授权了其他账户${others.length ? `(${others.join("、")})` : ""}`, others };
  }
  if (status === 5) return { secure: false, detail: "Windows ACL 没有给当前用户完全控制", others: [] };
  return { secure: false, detail: `Windows ACL 检查异常(exit ${status})`, others: [] };
}

/** 同 privateFilePermissions 的 Windows 分支,但不阻塞事件循环(请求路径上用)。 */
function windowsAclCheckAsync(file: string): Promise<WindowsAclCheck> {
  return new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_CHECK_ACL],
      { env: windowsAclEnv(file), encoding: "utf8", windowsHide: true, timeout: 10_000, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (!error) return resolve(windowsAclVerdict(0, stdout));
        const failure = error as { code?: unknown; killed?: boolean };
        resolve(typeof failure.code === "number" && !failure.killed ? windowsAclVerdict(failure.code, stdout) : windowsAclVerdict(null, null, error));
      });
  });
}

export function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export function sha256Text(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function atomicWrite(p: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.part`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

export function writeJson(p: string, obj: unknown): void {
  atomicWrite(p, JSON.stringify(obj, null, 2) + "\n");
}

export function readJson<T = unknown>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

export function readJsonIfExists<T = unknown>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try {
    return readJson<T>(p);
  } catch {
    return null;
  }
}

export function appendJsonl(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, "a");
  try {
    fs.writeSync(fd, JSON.stringify(obj) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function listFiles(dir: string, ext?: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith(".") && (!ext || f.endsWith(ext)))
    .sort()
    .map((f) => path.join(dir, f));
}

export function nowIso(d = new Date()): string {
  // Asia/Shanghai ISO 字符串(台账的录入时间都用这一种写法:按字符串比先后,混进 `Z` 结尾的写法顺序就乱了)
  const sh = new Date(d.getTime() + 8 * 3600 * 1000);
  return sh.toISOString().replace("Z", "+08:00");
}

export function ensureDirs(root: string, subs: string[]): void {
  for (const s of subs) fs.mkdirSync(path.join(root, s), { recursive: true });
}
