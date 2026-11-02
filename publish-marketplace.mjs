// Marketplace への公開（GitHub Actions の Trusted Publishing）の本体。GitLab Release の VSIX を取得・照合して vsce publish --oidc で出す。
// このファイルの正本は GitLab のリポジトリの src/github-actions/。公開専用の GitHub リポジトリへは `release.mjs github-sync` が複写する
// （docs/PUBLISHING.md §5.1）。node: 組み込みだけを使い、このリポジトリの他のコードを import しない（GitHub 側には複写されない）。
//   node publish-marketplace.mjs wait    --version <x.y.z> [--wait-minutes <分>]   GitLab Release が現れるまで待つ
//   node publish-marketplace.mjs verify  --version <x.y.z>                         SHA256SUMS・VSIX を取得し、照合して work/ へ置く
//   node publish-marketplace.mjs publish --version <x.y.z>                         未公開なら vsce publish --oidc（公開済みは何もしない）
//   node publish-marketplace.mjs check   --version <x.y.z>                         公開 API に版が載ったことを確かめる
// 秘密は持たない・出さない（OIDC のトークンは vsce が GitHub の ACTIONS_ID_TOKEN_REQUEST_* から直接取る）。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** GitLab のこのプロジェクト（公開の VSIX・SHA256SUMS の置き場。package.json の repository.url と一致する。github-actions.test.ts が検査） */
export const GITLAB_PROJECT_PATH = 'jumpohashimoto/kakizaki-agent-controller';
export const PUBLISHER = 'jumpohashimoto';
export const EXTENSION_NAME = 'kakizaki-agent-controller';

const GITLAB_API = 'https://gitlab.com/api/v4'; // secrets-scan:allow 公開リポジトリ自身の URL（コードの定数）
const GENERIC_PACKAGE_NAME = 'agent-controller';
const SHA256_SUMS_NAME = 'SHA256SUMS';
const MARKETPLACE_QUERY_URL =
  'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const MARKETPLACE_API_VERSION = '7.1-preview.1';
/** extensionquery の filterType: 拡張 ID（<publisher>.<name>）で絞る */
const FILTER_TYPE_EXTENSION_NAME = 7;
/** extensionquery の flags: IncludeVersions（1）+ IncludeVersionProperties（16）。全版を返す（最新 1 版だけにしない） */
const QUERY_FLAGS = 1 | 16;
const REQUEST_TIMEOUT_MS = 60_000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_NOT_FOUND = 404;
const POLL_INTERVAL_MS = 30_000;
const MS_PER_MINUTE = 60_000;
const DEFAULT_WAIT_MINUTES = 30;
const MAX_WAIT_MINUTES = 120;
const CHECK_TIMEOUT_MS = 5 * MS_PER_MINUTE;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MINUTES_PATTERN = /^\d+$/;
const SUMS_LINE_PATTERN = /^([0-9a-f]{64}) [ *](.+)$/;
const COMMANDS = Object.freeze(['wait', 'verify', 'publish', 'check']);
const USAGE =
  '使い方: node publish-marketplace.mjs <wait|verify|publish|check> --version <x.y.z> [--wait-minutes <分>]';

/**
 * @typedef {{
 *   fetch: typeof fetch,
 *   env: Record<string, string | undefined>,
 *   workDir: string,
 *   log: (message: string) => void,
 *   sleep: (ms: number) => Promise<void>,
 *   nowMs: () => number,
 *   makeDirectory: (directory: string) => void,
 *   writeFile: (file: string, data: Uint8Array) => void,
 *   readFile: (file: string) => Buffer,
 *   run: (command: string, args: readonly string[], options?: {inherit?: boolean}) => Promise<{status: number, stdout: string}>,
 * }} Deps
 */

/**
 * @param {readonly string[]} argv
 * @param {string} name
 * @returns {string | undefined}
 */
function readOption(argv, name) {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

/**
 * 引数を検証する（版は x.y.z だけ。値をシェルや URL に渡す前に形を固定する）。
 * @param {readonly string[]} argv
 * @returns {{command: string, version: string, waitMinutes: number}}
 */
export function parseArguments(argv) {
  const [command = ''] = argv;
  if (!COMMANDS.includes(command)) throw new Error(USAGE);
  const version = readOption(argv, '--version');
  if (version === undefined) throw new Error(`--version が必要です。${USAGE}`);
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`版は x.y.z の形で指定してください: ${version}`);
  }
  const minutes = readOption(argv, '--wait-minutes');
  const waitMinutes = minutes === undefined ? DEFAULT_WAIT_MINUTES : Number(minutes);
  if (
    (minutes !== undefined && !MINUTES_PATTERN.test(minutes)) ||
    waitMinutes < 1 ||
    waitMinutes > MAX_WAIT_MINUTES
  ) {
    throw new Error(`--wait-minutes は 1 から ${MAX_WAIT_MINUTES} の整数で指定してください`);
  }
  return { command, version, waitMinutes };
}

/** @param {string} version */
const vsixFileName = (version) => `${EXTENSION_NAME}-${version}.vsix`;

/** @param {string} version */
const packageBaseUrl = (version) =>
  `${GITLAB_API}/projects/${encodeURIComponent(GITLAB_PROJECT_PATH)}/packages/generic/${GENERIC_PACKAGE_NAME}/${version}`;

/** @param {Response} response */
const isHttpOk = (response) => response.status >= HTTP_OK_MIN && response.status <= HTTP_OK_MAX;

/**
 * @param {Deps} deps
 * @param {string} url
 * @param {RequestInit} [init]
 */
const request = (deps, url, init = {}) =>
  deps.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

/**
 * GitLab Release が現れるまで待つ（publish:gitlab が VSIX・SHA256SUMS を置いてから Release を作るので、Release があれば揃っている）。
 * 404 と一過性の失敗（5xx・通信断）は待ちを続け、上限を過ぎたら失敗にする。
 * @param {Deps} deps
 * @param {{version: string, waitMinutes: number}} options
 * @returns {Promise<void>}
 */
export async function waitForRelease(deps, { version, waitMinutes }) {
  const releaseUrl = `${GITLAB_API}/projects/${encodeURIComponent(GITLAB_PROJECT_PATH)}/releases/v${version}`;
  const deadline = deps.nowMs() + waitMinutes * MS_PER_MINUTE;
  for (;;) {
    try {
      const response = await request(deps, releaseUrl);
      if (isHttpOk(response)) return;
      if (response.status !== HTTP_NOT_FOUND) {
        deps.log(`GitLab Release を確認できません（HTTP ${response.status}）。待ちを続けます`);
      }
    } catch (error) {
      deps.log(
        `GitLab Release を確認できません（${error instanceof Error ? error.message : String(error)}）。待ちを続けます`,
      );
    }
    if (deps.nowMs() + POLL_INTERVAL_MS > deadline) {
      throw new Error(`GitLab Release v${version} が ${waitMinutes} 分以内に現れませんでした`);
    }
    deps.log(`GitLab Release v${version} を待っています`);
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * @param {Deps} deps
 * @param {string} url
 * @param {string} label
 * @returns {Promise<Buffer>}
 */
async function download(deps, url, label) {
  const response = await request(deps, url);
  if (!isHttpOk(response)) throw new Error(`${label} を取得できません（HTTP ${response.status}）`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * SHA256SUMS（`<64 桁の 16 進>  <ファイル名>`）から、ファイル名の SHA-256 を探す。
 * @param {string} text
 * @param {string} name
 * @returns {string | undefined}
 */
function sha256sFor(text, name) {
  for (const line of text.split('\n')) {
    const match = SUMS_LINE_PATTERN.exec(line);
    if (match?.[2] === name) return match[1];
  }
  return undefined;
}

/**
 * VSIX の package.json が、入力の版・publisher・名前と一致することを確かめる（入力の取り違えと置き場の差し替えを止める）。
 * @param {Deps} deps
 * @param {string} vsixPath
 * @param {string} version
 */
async function verifyManifest(deps, vsixPath, version) {
  const { status, stdout } = await deps.run('unzip', ['-p', vsixPath, 'extension/package.json']);
  if (status !== 0)
    throw new Error(`unzip で VSIX の package.json を取り出せません（終了コード ${status}）`);
  /** @type {{name?: unknown, publisher?: unknown, version?: unknown}} */
  let manifest;
  try {
    manifest = JSON.parse(stdout);
  } catch {
    throw new Error('VSIX の package.json を読めません');
  }
  if (
    manifest.version !== version ||
    manifest.publisher !== PUBLISHER ||
    manifest.name !== EXTENSION_NAME
  ) {
    throw new Error(
      `VSIX の package.json が入力と一致しません（期待: ${PUBLISHER}.${EXTENSION_NAME}@${version}）`,
    );
  }
}

/**
 * GitLab Release の SHA256SUMS と VSIX を取得し、SHA-256 が一致したときだけ作業ディレクトリへ置く。再ビルドはしない。
 * @param {Deps} deps
 * @param {{version: string}} options
 * @returns {Promise<void>}
 */
export async function verifyRelease(deps, { version }) {
  const name = vsixFileName(version);
  const base = packageBaseUrl(version);
  const sums = (await download(deps, `${base}/${SHA256_SUMS_NAME}`, SHA256_SUMS_NAME)).toString(
    'utf8',
  );
  const expected = sha256sFor(sums, name);
  if (expected === undefined) throw new Error(`${SHA256_SUMS_NAME} に ${name} の行がありません`);
  const vsix = await download(deps, `${base}/${name}`, name);
  const actual = createHash('sha256').update(vsix).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `${name} の SHA-256 が一致しません（${SHA256_SUMS_NAME} と取得した VSIX が違います）`,
    );
  }
  deps.makeDirectory(deps.workDir);
  const vsixPath = path.posix.join(deps.workDir, name);
  deps.writeFile(vsixPath, vsix);
  await verifyManifest(deps, vsixPath, version);
  deps.log(`${name}: ${SHA256_SUMS_NAME} と一致し、package.json も入力と一致しました`);
}

/**
 * Marketplace の公開 API（extensionquery。認証なし）で、公開済みの版の一覧を得る。
 * @param {Deps} deps
 * @returns {Promise<string[]>}
 */
async function publishedVersions(deps) {
  const response = await request(deps, MARKETPLACE_QUERY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: `application/json;api-version=${MARKETPLACE_API_VERSION}`,
    },
    body: JSON.stringify({
      filters: [
        {
          criteria: [
            { filterType: FILTER_TYPE_EXTENSION_NAME, value: `${PUBLISHER}.${EXTENSION_NAME}` },
          ],
        },
      ],
      flags: QUERY_FLAGS,
    }),
  });
  if (!isHttpOk(response)) {
    throw new Error(`Marketplace の公開状況を確認できません（HTTP ${response.status}）`);
  }
  const body =
    /** @type {{results?: Array<{extensions?: Array<{versions?: Array<{version?: unknown}>}>}>}} */ (
      await response.json()
    );
  const extensions = body.results?.[0]?.extensions;
  if (!Array.isArray(extensions)) {
    throw new Error('Marketplace の応答を読めません（results[0].extensions がありません）');
  }
  return (extensions[0]?.versions ?? []).map((entry) => String(entry.version));
}

/**
 * 未公開なら vsce publish --oidc で出す（公開済みなら何もしない）。vsce は GitHub の OIDC トークンを Marketplace の資格に交換する。
 * @param {Deps} deps
 * @param {{version: string}} options
 * @returns {Promise<'published' | 'skipped'>}
 */
export async function publishVersion(deps, { version }) {
  const vsixPath = path.posix.join(deps.workDir, vsixFileName(version));
  if ((await publishedVersions(deps)).includes(version)) {
    deps.log(
      `${PUBLISHER}.${EXTENSION_NAME}@${version} は Marketplace に公開済みのため、何もしません`,
    );
    return 'skipped';
  }
  try {
    deps.readFile(vsixPath);
  } catch {
    throw new Error(
      `${vsixPath} がありません。先に verify を実行してください（照合していない VSIX は公開しません）`,
    );
  }
  if (deps.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('GitHub Actions の中でだけ公開できます（OIDC のトークンの発行元が無い）');
  }
  const { status } = await deps.run(
    'npx',
    [
      '--no-install',
      'vsce',
      'publish',
      '--oidc',
      '--no-dependencies',
      '--packagePath',
      vsixPath,
      '--skip-duplicate',
    ],
    { inherit: true },
  );
  if (status !== 0) throw new Error(`vsce publish が失敗しました（終了コード ${status}）`);
  deps.log(`${PUBLISHER}.${EXTENSION_NAME}@${version} を公開しました`);
  return 'published';
}

/**
 * Marketplace の公開 API に版が載るまで待つ（反映の遅れ・一過性の失敗は待つ。上限 5 分）。
 * @param {Deps} deps
 * @param {{version: string}} options
 * @returns {Promise<void>}
 */
export async function checkPublished(deps, { version }) {
  const deadline = deps.nowMs() + CHECK_TIMEOUT_MS;
  for (;;) {
    try {
      if ((await publishedVersions(deps)).includes(version)) {
        deps.log(`Marketplace に ${PUBLISHER}.${EXTENSION_NAME}@${version} を確認しました`);
        return;
      }
    } catch (error) {
      deps.log(
        `公開状況を確認できません（${error instanceof Error ? error.message : String(error)}）。待ちを続けます`,
      );
    }
    if (deps.nowMs() + POLL_INTERVAL_MS > deadline) {
      throw new Error(
        `Marketplace に ${PUBLISHER}.${EXTENSION_NAME}@${version} が現れませんでした（反映に時間がかかっている可能性があります。管理ページを確認してください）`,
      );
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * @param {readonly string[]} argv
 * @param {Deps} deps
 * @returns {Promise<number>} 終了コード
 */
export async function runCommand(argv, deps) {
  try {
    const { command, version, waitMinutes } = parseArguments(argv);
    if (command === 'wait') await waitForRelease(deps, { version, waitMinutes });
    else if (command === 'verify') await verifyRelease(deps, { version });
    else if (command === 'publish') await publishVersion(deps, { version });
    else await checkPublished(deps, { version });
    return 0;
  } catch (error) {
    deps.log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** @returns {Deps} */
function realDeps() {
  return {
    fetch: globalThis.fetch,
    env: process.env,
    workDir: 'work',
    log: (message) => console.log(message),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowMs: () => Date.now(),
    makeDirectory: (directory) => mkdirSync(directory, { recursive: true }),
    writeFile: (file, data) => writeFileSync(file, data),
    readFile: (file) => readFileSync(file),
    run: (command, args, { inherit = false } = {}) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          stdio: ['ignore', inherit ? 'inherit' : 'pipe', 'inherit'],
        });
        let stdout = '';
        child.stdout?.on('data', (chunk) => {
          stdout += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ status: code ?? 1, stdout }));
      }),
  };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCommand(process.argv.slice(2), realDeps()).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
