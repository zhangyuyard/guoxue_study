#!/usr/bin/env node
/**
 * Android 发布构建脚本（release-android.mjs）
 *
 * 用法（项目根目录执行）：
 *   npm run android:apk      打 release APK（可直接安装 / 国内市场上架）
 *   npm run android:aab      打 release AAB（Google Play 上架）
 *   npm run android:release  两个都打
 *
 * 可选参数（追加在命令后，npm 需加 --）：
 *   npm run android:apk -- --clean      构建前 clean（全量重编，慢但干净）
 *   npm run android:apk -- --no-verify  跳过 apksigner 签名校验
 *
 * 脚本会依次完成：
 *   1) 前置检查（签名证书 / 签名配置 / SDK / 随包字典资源）
 *   2) 调用 gradlew 构建
 *   3) 产物归档到 deliverables/android/，文件名带版本号与日期
 *   4) apksigner 校验签名（仅 APK）+ 输出体积、SHA-256
 *
 * 签名证书与密码位于：
 *   android/app/guoxue-release.keystore        （已加入 .gitignore）
 *   ~/.gradle/gradle.properties                （GUOXUE_UPLOAD_*，不入库）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = join(ROOT, 'android');
const APP = join(ANDROID, 'app');
const OUT_DIR = join(ROOT, 'deliverables', 'android');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m' };
const log = (msg = '') => console.log(msg);
const step = (msg) => log(`${C.cyan}▶${C.reset} ${msg}`);
const ok = (msg) => log(`${C.green}✔${C.reset} ${msg}`);
const warn = (msg) => log(`${C.yellow}⚠${C.reset} ${msg}`);
const fail = (msg) => {
  log(`${C.red}✘${C.reset} ${msg}`);
  process.exit(1);
};

// ---------- 参数解析 ----------

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const target = (positional[0] || 'apk').toLowerCase();
const doClean = flags.has('--clean');
const doVerify = !flags.has('--no-verify');

if (!['apk', 'aab', 'both'].includes(target)) {
  fail(`未知的构建目标 "${target}"，可选：apk | aab | both`);
}
const buildApk = target === 'apk' || target === 'both';
const buildAab = target === 'aab' || target === 'both';

// ---------- 前置检查 ----------

step('检查构建环境');

/** 读取 Android SDK 路径（与 gradle 一致，优先 local.properties） */
function resolveSdkDir() {
  const lp = join(ANDROID, 'local.properties');
  if (existsSync(lp)) {
    const m = /^\s*sdk\.dir=(.+)$/m.exec(readFileSync(lp, 'utf8'));
    if (m) return m[1].trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\');
  }
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
}

/** 定位 apksigner（取 build-tools 下最新版本） */
function findApksigner(sdkDir) {
  const btDir = join(sdkDir, 'build-tools');
  if (!existsSync(btDir)) return null;
  const exe = process.platform === 'win32' ? 'apksigner.bat' : 'apksigner';
  const versions = readdirSync(btDir)
    .filter((v) => existsSync(join(btDir, v, exe)))
    .sort()
    .reverse();
  return versions.length ? join(btDir, versions[0], exe) : null;
}

const sdkDir = resolveSdkDir();
if (!sdkDir || !existsSync(sdkDir)) {
  fail(`未找到 Android SDK。请在 android/local.properties 中配置 sdk.dir，或设置 ANDROID_HOME 环境变量。${sdkDir ? `（当前解析到：${sdkDir}）` : ''}`);
}
ok(`Android SDK：${sdkDir}`);

// 签名证书
const keystorePath = join(APP, 'guoxue-release.keystore');
if (!existsSync(keystorePath)) {
  fail(
    `缺少签名证书 ${keystorePath}\n` +
      `  生成命令：\n` +
      `  keytool -genkeypair -v -storetype PKCS12 -keystore ${keystorePath} \\\n` +
      `    -alias guoxue -keyalg RSA -keysize 2048 -validity 10000 \\\n` +
      `    -storepass <密码> -keypass <密码> \\\n` +
      `    -dname "CN=Guoxue Study App, OU=Dev, O=GuoxueStudy, L=Beijing, ST=Beijing, C=CN"`,
  );
}
ok(`签名证书：${basename(keystorePath)}`);

// 签名配置（缺失时 gradle 会静默回退 debug 签名，这里显式拦住）
const globalProps = join(process.env.HOME || process.env.USERPROFILE || '', '.gradle', 'gradle.properties');
const hasSigningConfig = existsSync(globalProps) && readFileSync(globalProps, 'utf8').includes('GUOXUE_UPLOAD_STORE_FILE');
if (!hasSigningConfig) {
  fail(
    `未配置签名信息，release 会回退成 debug 签名（无法上架）。\n` +
      `  请在 ${globalProps} 中添加：\n` +
      `  GUOXUE_UPLOAD_STORE_FILE=${keystorePath}\n` +
      `  GUOXUE_UPLOAD_KEY_ALIAS=guoxue\n` +
      `  GUOXUE_UPLOAD_STORE_PASSWORD=<证书密码>\n` +
      `  GUOXUE_UPLOAD_KEY_PASSWORD=<证书密码>`,
  );
}
ok('签名配置：已就绪（~/.gradle/gradle.properties）');

// 随包字典资源（缺失会导致 App 内字典不可用，且不会报错）
const dictDb = join(APP, 'src/main/assets/dictionaries/native_dict.db');
if (!existsSync(dictDb)) {
  warn(`未找到随包字典 ${basename(dictDb)}，先执行 npm run build:native-dict 再打包，否则 App 内字典为空`);
} else {
  ok(`随包字典：${basename(dictDb)}（${(statSync(dictDb).size / 1048576).toFixed(1)} MB）`);
}

// 版本信息
const gradleText = readFileSync(join(APP, 'build.gradle'), 'utf8');
const applicationId = /applicationId\s+"([^"]+)"/.exec(gradleText)?.[1] ?? 'unknown';
const versionName = /versionName\s+"([^"]+)"/.exec(gradleText)?.[1] ?? '1.0';
const versionCode = /versionCode\s+(\d+)/.exec(gradleText)?.[1] ?? '1';
log(`${C.dim}  包名 ${applicationId} · versionName ${versionName} · versionCode ${versionCode}${C.reset}`);

// ---------- 构建 ----------

const gradleExe = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const gradleSpawn = { cwd: ANDROID, stdio: 'inherit' };

function runGradle(tasks) {
  const r = spawnSync(gradleExe, tasks, gradleSpawn);
  if (r.error) fail(`无法执行 ${gradleExe}：${r.error.message}`);
  if (r.status !== 0) fail(`Gradle 构建失败（退出码 ${r.status}）`);
}

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

if (buildApk) {
  step(doClean ? '构建 APK（clean 全量）' : '构建 APK');
  runGradle([...(doClean ? ['clean'] : []), 'assembleRelease']);
}
if (buildAab) {
  step('构建 AAB');
  runGradle(['bundleRelease']);
}

// ---------- 归档与校验 ----------

function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', rej)
      .on('end', () => res(h.digest('hex')));
  });
}

function archive(src, ext, label) {
  if (!existsSync(src)) return fail(`未找到构建产物：${src}`);
  const dest = join(OUT_DIR, `guoxue-study-${versionName}-${stamp}.${ext}`);
  rmSync(dest, { force: true });
  copyFileSync(src, dest);
  return { dest, label };
}

const results = [];
if (buildApk) results.push(archive(join(APP, 'build/outputs/apk/release/app-release.apk'), 'apk', 'APK'));
if (buildAab) results.push(archive(join(APP, 'build/outputs/bundle/release/app-release.aab'), 'aab', 'AAB'));

const apksigner = doVerify ? findApksigner(sdkDir) : null;
if (doVerify && !apksigner) warn('未找到 apksigner，跳过签名校验');

log('');
log(`${C.bold}产物${C.reset}`);
for (const { dest, label } of results) {
  const sizeMB = (statSync(dest).size / 1048576).toFixed(1);
  const hash = await sha256(dest);
  log(`  ${C.bold}${label}${C.reset}  ${basename(dest)}`);
  log(`  ${C.dim}${sizeMB} MB · sha256 ${hash}${C.reset}`);
}

// 签名校验（同步，APK 才有意义）
if (apksigner) {
  const apk = results.find((r) => r.label === 'APK');
  if (apk) {
    step('校验签名');
    const v = spawnSync(apksigner, ['verify', '--print-certs', '-v', apk.dest], { encoding: 'utf8' });
    const out = `${v.stdout ?? ''}${v.stderr ?? ''}`;
    const lines = out.split('\n').filter((l) => /Verifies|scheme \(|^Signer #1 certificate (DN|SHA-1)/.test(l.trim()));
    if (v.status === 0) {
      ok('签名校验通过');
      for (const l of lines) log(`  ${C.dim}${l.trim()}${C.reset}`);
    } else {
      fail(`签名校验失败：\n${out}`);
    }
  }
}

log('');
log(`${C.bold}后续${C.reset}`);
const apkResult = results.find((r) => r.label === 'APK');
const aabResult = results.find((r) => r.label === 'AAB');
if (apkResult) {
  log(`  ${C.dim}安装到手机：adb install -r deliverables/android/${basename(apkResult.dest)}${C.reset}`);
}
if (aabResult) {
  log(`  ${C.dim}AAB 不能直接安装，上传到 Google Play，或用 bundletool 本地转成 apks：${C.reset}`);
  log(`  ${C.dim}java -jar bundletool.jar build-apks --bundle=deliverables/android/${basename(aabResult.dest)} --output=app.apks${C.reset}`);
}
log(`  ${C.dim}下次发版记得递增 android/app/build.gradle 里的 versionCode（当前 ${versionCode}）${C.reset}`);
log(`  ${C.dim}证书与密码请离线备份：android/app/guoxue-release.keystore${C.reset}`);
log('');
ok('打包完成');
