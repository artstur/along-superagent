#!/usr/bin/env node
// Along 阶段 A 迁移备份（docs/stage-a-tech-design.md §2.7.4；BC-09-01、BC-09-07；SD-10）。
//
// 流程：协调停写检查 → 业务库与 orchestrator.sqlite 用 `VACUUM INTO` 出一致性快照（不是文件复制——
// BC-09-07 明确「不把直接复制写入中的 SQLite 当备份」）→ DSH stateDir 其余内容归档（工单目录 work/、
// worker-bin、worker-gitconfig；worker 会话记录若落在 stateDir 内随之归档，落在别处时用 --extra-dir 登记）
// → Hy-Memory 目录（~/.along/memory，停机时复制）→ 配置（profile 配置目录、~/.along/agent-host、bridge-token）
// → 产出 manifest.json（每个文件的大小与 sha256、来源、数据库快照的表计数）。
//
// 「Skill 版本」清单项在阶段 A 显式登记为不适用：尚无 Skill 版本链，prompt 版本已随 orchestrator.sqlite
// 快照覆盖（§2.7.4），恢复演练（BC-09-06）在阶段 E。
//
// 停写判定：Runtime 持 proper-lockfile 目录锁（src/app/runtime.ts），锁文件是 `<目录>.lock`（与目录同级的
// 兄弟文件）。两把锁（DSH stateDir、alongStateDir）任一存在即视为运行中，拒绝备份并给出停写指引；
// `--allow-active` 显式越过时只允许 VACUUM INTO（快照仍一致），目录复制按「写入中」警告登记。
//
// 用法：
//   node scripts/along-backup.mjs --out <备份目录> --state-dir <DSH stateDir> \
//     [--along-state-dir ~/.along/along-data] [--memory-dir ~/.along/memory] [--host-dir ~/.along/agent-host] \
//     [--config-dir ~/.dsh/profiles/superagent] [--extra-dir <目录>…] [--allow-active]
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {basename, dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';

function usage(message) {
  if (message) console.error(`along-backup: ${message}`);
  console.error('用法：node scripts/along-backup.mjs --out <备份目录> --state-dir <DSH stateDir> [--along-state-dir ~/.along/along-data] [--memory-dir ~/.along/memory] [--host-dir ~/.along/agent-host] [--config-dir ~/.dsh/profiles/superagent] [--extra-dir <目录>]… [--allow-active]');
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const args = {extraDirs: []};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case '--out': args.out = value; i++; break;
      case '--state-dir': args.stateDir = value; i++; break;
      case '--along-state-dir': args.alongStateDir = value; i++; break;
      case '--memory-dir': args.memoryDir = value; i++; break;
      case '--host-dir': args.hostDir = value; i++; break;
      case '--config-dir': args.configDir = value; i++; break;
      case '--extra-dir': if (!value) usage('--extra-dir 需要目录参数'); args.extraDirs.push(value); i++; break;
      case '--allow-active': args.allowActive = true; break;
      case '--help': usage(); break;
      default: usage(`未知参数 ${arg}`);
    }
  }
  if (!args.out) usage('缺少 --out <备份目录>');
  if (!args.stateDir) usage('缺少 --state-dir <DSH stateDir>（profile 配置里的 stateDir，docs/006-deployment.md）');
  return args;
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const exists = dir => existsSync(dir) && statSync(dir).isDirectory();

/** One archived file: bytes + sha256 + where it came from (manifest core, BC-09-01 核对依据). */
function record(manifest, source, relative) {
  const bytes = statSync(source).size;
  manifest.push({path: relative, source, bytes, sha256: sha256(source)});
  return bytes;
}

/** Copies one directory tree into the backup, recording every file. Empty/missing dirs are noted, not fatal. */
function archiveDir(manifest, source, target, {warnActive = false} = {}) {
  if (!exists(source)) { manifest.push({path: target, source, missing: true}); return 0; }
  cpSync(source, target, {recursive: true});
  let bytes = 0;
  const walk = (dir, relative) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const from = join(dir, entry.name), to = join(relative, entry.name);
      if (entry.isDirectory()) walk(from, to);
      else bytes += record(manifest, from, to);
    }
  };
  walk(source, target);
  if (warnActive) manifest.push({path: target, source, warning: 'BC-09-07：源目录在写入中被复制，条目可能不构成一致快照'});
  return bytes;
}

/** Consistency snapshot via SQLite's own `VACUUM INTO` (SD-10): a single-file, self-contained copy even if the
 * source was written mid-run. The target must not exist; the source opens read-only. */
function vacuumInto(source, target, manifest) {
  mkdirSync(dirname(target), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(source, {readOnly: true});
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally { db.close(); }
  record(manifest, target, target);
  // 表计数随清单落盘，恢复侧可直接核对「快照可打开、计数与源一致」（BC-09-01 冒烟口径）。
  const counts = {};
  const snapshot = new DatabaseSync(target, {readOnly: true});
  try {
    const tables = snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const {name} of tables) counts[name] = Number(snapshot.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n);
  } finally { snapshot.close(); }
  manifest.push({path: target, tables: counts});
  return statSync(target).size;
}

const args = parseArgs(process.argv.slice(2));
const alongStateDir = resolve(args.alongStateDir ?? join(homedir(), '.along', 'along-data'));
const stateDir = resolve(args.stateDir);
const memoryDir = resolve(args.memoryDir ?? join(homedir(), '.along', 'memory'));
const hostDir = resolve(args.hostDir ?? join(homedir(), '.along', 'agent-host'));
const configDir = args.configDir ? resolve(args.configDir) : undefined;
const out = resolve(args.out);

// 协调停写（§2.7.4 第一步）：锁在 → 进程在写 → 拒绝；越权须显式 --allow-active 且只信 VACUUM INTO。
const locks = [stateDir, alongStateDir].map(dir => `${dir}.lock`).filter(existsSync);
if (locks.length !== 0 && !args.allowActive) {
  console.error(`along-backup: 检测到运行中的目录锁，先协调停写再备份：${locks.join(', ')}`);
  console.error('停写步骤：把 Along Host 的 ALONG_EVENT_INGEST 保持 off 并退出 Host（host/agent-host.mjs），退出 dsh-superagent 进程（锁随进程释放）；确认两个 .lock 文件消失后重跑。确需热备份时用 --allow-active，此时只有 VACUUM INTO 快照是可靠的。');
  process.exit(1);
}
if (locks.length !== 0) console.warn('along-backup: --allow-active：目录复制部分对写入中的源执行，已在 manifest 中逐条警告（BC-09-07）');
if (!exists(stateDir)) usage(`stateDir 不存在：${stateDir}`);
if (!exists(alongStateDir)) usage(`alongStateDir 不存在：${alongStateDir}`);
const businessDb = join(alongStateDir, 'along.sqlite');
if (!existsSync(businessDb)) usage(`业务库不存在：${businessDb}（先启动一次 Along 本地部署让 fork 建库）`);
if (existsSync(out)) usage(`备份目录已存在，拒绝覆盖：${out}`);

mkdirSync(out, {recursive: true, mode: 0o700});
const manifest = [];
let bytes = 0;
bytes += vacuumInto(businessDb, join(out, 'along', 'along.sqlite'), manifest);
bytes += vacuumInto(join(stateDir, 'orchestrator.sqlite'), join(out, 'dsh', 'orchestrator.sqlite'), manifest);
// along-data 的其余内容（bridge-token，§4.7）与 stateDir 其余内容（docs/006-deployment.md:99「Back it up」）：
// 工单目录、worker-bin、worker-gitconfig、锁与 shims；SQLite 及其 WAL/SHM 不复制——逻辑内容已由上面的
// VACUUM INTO 快照承载（BC-09-07）。
const alongEntries = readdirSync(alongStateDir, {withFileTypes: true})
  .filter(entry => !/\.sqlite(-wal|-shm)?$/.test(entry.name));
for (const entry of alongEntries) {
  const from = join(alongStateDir, entry.name);
  if (entry.isDirectory()) bytes += archiveDir(manifest, from, join(out, 'along-state', entry.name), {warnActive: locks.length !== 0});
  else { cpSync(from, join(out, 'along-state', entry.name)); bytes += record(manifest, join(out, 'along-state', entry.name), join(out, 'along-state', entry.name)); }
}
const stateEntries = readdirSync(stateDir, {withFileTypes: true})
  .filter(entry => !/\.sqlite(-wal|-shm)?$/.test(entry.name));
for (const entry of stateEntries) {
  const from = join(stateDir, entry.name);
  if (entry.isDirectory()) bytes += archiveDir(manifest, from, join(out, 'dsh-state', entry.name), {warnActive: locks.length !== 0});
  else { cpSync(from, join(out, 'dsh-state', entry.name)); bytes += record(manifest, join(out, 'dsh-state', entry.name), join(out, 'dsh-state', entry.name)); }
}
bytes += archiveDir(manifest, memoryDir, join(out, 'memory'), {warnActive: locks.length !== 0});
bytes += archiveDir(manifest, hostDir, join(out, 'config', 'agent-host'), {warnActive: locks.length !== 0});
if (configDir) bytes += archiveDir(manifest, configDir, join(out, 'config', 'profile'), {warnActive: locks.length !== 0});
for (const extra of args.extraDirs) bytes += archiveDir(manifest, resolve(extra), join(out, 'extra', basename(resolve(extra))), {warnActive: locks.length !== 0});

const report = {
  created_at: new Date().toISOString(),
  along_state_dir: alongStateDir, dsh_state_dir: stateDir, memory_dir: memoryDir, host_dir: hostDir,
  ...(configDir ? {config_dir: configDir} : {}),
  stopped_write: locks.length === 0 ? 'confirmed（两把目录锁均不在）' : 'NOT CONFIRMED（--allow-active 越过）',
  skill_versions: '阶段 A 不适用：尚无 Skill 版本链；prompt 版本已随 orchestrator.sqlite 快照覆盖（§2.7.4）',
  worker_session_records: '由 Harness 运行时装配落盘：若位于 stateDir 内已随 dsh-state/ 归档；若在别处，请用 --extra-dir 登记后重跑',
  total_bytes: bytes,
  // 清单两类条目：带 sha256 的归档文件，与不带 sha256 的说明性条目（目录缺失、热复制警告、表计数）。
  files: manifest.filter(entry => entry.sha256 !== undefined || entry.missing !== undefined
    || entry.warning !== undefined || entry.tables !== undefined),
};
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`, {mode: 0o600});
console.log(`along-backup: 备份完成 → ${out}（${manifest.filter(entry => entry.sha256 !== undefined).length} 个文件，共 ${bytes} 字节；manifest.json 已含 sha256 与表计数）`);
