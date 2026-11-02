// 公開専用の GitHub リポジトリのワークフロー（Marketplace・Open VSX）が共有する、GitLab Release の VSIX の取得・照合と実行の枠。
// このファイルの正本は GitLab のリポジトリの src/github-actions/。公開専用の GitHub リポジトリへは `release.mjs github-sync` が複写する
// （docs/PUBLISHING.md §5.1）。node: 組み込みだけを使い、このリポジトリの他のコードを import しない（GitHub 側には複写されない）。
// 配布先ごとのスクリプト（publish-marketplace.mjs・publish-openvsx.mjs）が、次の 4 つのコマンドで使う:
//   wait    --version <x.y.z> [--wait-minutes <分>]   GitLab Release が現れるまで待つ
//   verify  --version <x.y.z>                         SHA256SUMS・VSIX を取得し、照合して work/ へ置く
//   publish --version <x.y.z>                         未公開なら公開する（配布先ごと。公開済みは何もしない）
//   check   --version <x.y.z>                         公開 API に版が載ったことを確かめる（配布先ごと）
// 秘密は持たない・出さない（OIDC のトークンは vsce・ovsx が GitHub の ACTIONS_ID_TOKEN_REQUEST_* から直接取る）。
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
const REQUEST_TIMEOUT_MS = 60_000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_NOT_FOUND = 404;
const POLL_INTERVAL_MS = 30_000;
export const MS_PER_MINUTE = 60_000;
const DEFAULT_WAIT_MINUTES = 30;
/**
 * wait の上限（分）。ワークフローのジョブの timeout-minutes は「この値 + CHECK_TIMEOUT_MS + 他のステップの余裕」に収める
 * （GitHub に途中で打ち切られて原因がログに残らない状況を作らない。github-actions.test.ts が固定）。
 */
export const MAX_WAIT_MINUTES = 30;
/**
 * check の上限。配布先は公開した版を検証してから一覧に載せることがあり、反映に時間がかかる（所要時間は公式文書になく未確認。
 * 次の版の本番の run で実測して見直す）。超えても公開自体は成功しているので、失敗にはしない（waitUntilPublished）。
 */
export const CHECK_TIMEOUT_MS = 20 * MS_PER_MINUTE;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MINUTES_PATTERN = /^\d+$/;
const PACKAGE_PER_PAGE = 100;
const SUMS_LINE_PATTERN = /^([0-9a-f]{64}) [ *](.+)$/;
const COMMANDS = Object.freeze(['wait', 'verify', 'publish', 'check']);
const USAGE =
  '使い方: node publish-<配布先>.mjs <wait|verify|publish|check> --version <x.y.z> [--wait-minutes <分>]';

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
 * @typedef {{
 *   publish: (deps: Deps, options: {version: string}) => Promise<unknown>,
 *   check: (deps: Deps, options: {version: string}) => Promise<unknown>,
 * }} Handlers 配布先ごとの公開（publish）と反映の確認（check）
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

/**
 * 2xx か。
 * @param {Response} response
 */
export const isHttpOk = (response) =>
  response.status >= HTTP_OK_MIN && response.status <= HTTP_OK_MAX;

/**
 * 404 か（公開 API の「まだ無い」）。
 * @param {Response} response
 */
export const isHttpNotFound = (response) => response.status === HTTP_NOT_FOUND;

/**
 * タイムアウト付きの fetch。
 * @param {Deps} deps
 * @param {string} url
 * @param {RequestInit} [init]
 */
export const request = (deps, url, init = {}) =>
  deps.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

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
      if (!isHttpNotFound(response)) {
        deps.log(`GitLab Release を確認できません（HTTP ${response.status}）。待ちを続けます`);
      }
    } catch (error) {
      deps.log(`GitLab Release を確認できません（${messageOf(error)}）。待ちを続けます`);
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
 * Package Registry のファイル一覧（公開 API・認証なし）で、VSIX・SHA256SUMS が各 1 件だけ登録されていて、
 * VSIX の file_sha256 が SHA256SUMS の値と一致することを確かめる。generic パッケージは同名ファイルの重複登録を許し、
 * ダウンロード URL は最新を返すため、後から差し替えられていないかを本体の取得前に検出する（docs/PUBLISHING.md §5.1）。
 * @param {Deps} deps
 * @param {{version: string, vsixName: string, expectedSha256: string}} options
 * @returns {Promise<void>}
 */
async function verifyRegistryFiles(deps, { version, vsixName, expectedSha256 }) {
  const projectApi = `${GITLAB_API}/projects/${encodeURIComponent(GITLAB_PROJECT_PATH)}`;
  const listed = await request(
    deps,
    `${projectApi}/packages?package_type=generic&package_name=${GENERIC_PACKAGE_NAME}&package_version=${version}`,
  );
  if (!isHttpOk(listed)) {
    throw new Error(`Package Registry の置き場を確認できません（HTTP ${listed.status}）`);
  }
  const packages = /** @type {Array<{id?: unknown}>} */ (await listed.json());
  const packageId = Array.isArray(packages) ? packages[0]?.id : undefined;
  if (typeof packageId !== 'number') {
    throw new Error(`Package Registry に ${GENERIC_PACKAGE_NAME}@${version} がありません`);
  }
  const filesResponse = await request(
    deps,
    `${projectApi}/packages/${packageId}/package_files?per_page=${PACKAGE_PER_PAGE}`,
  );
  if (!isHttpOk(filesResponse)) {
    throw new Error(`Package Registry のファイルを確認できません（HTTP ${filesResponse.status}）`);
  }
  const files = /** @type {Array<{file_name?: unknown, file_sha256?: unknown}>} */ (
    await filesResponse.json()
  );
  for (const name of [vsixName, SHA256_SUMS_NAME]) {
    const count = Array.isArray(files) ? files.filter((file) => file.file_name === name).length : 0;
    if (count !== 1) {
      throw new Error(
        `${name} が Package Registry に ${count} 件登録されています（1 件だけのはずです。重複は後から差し替えられた疑いがあるため、GitLab 側で確かめてください）`,
      );
    }
  }
  const registered = files.find((file) => file.file_name === vsixName)?.file_sha256;
  if (registered !== expectedSha256) {
    throw new Error(
      `${vsixName} の Package Registry の file_sha256 が ${SHA256_SUMS_NAME} と一致しません`,
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
  await verifyRegistryFiles(deps, { version, vsixName: name, expectedSha256: expected });
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
 * verify が作業ディレクトリへ置いた VSIX のパス。無ければ（照合していない VSIX は公開しない）失敗にする。
 * @param {Deps} deps
 * @param {string} version
 * @returns {string}
 */
export function verifiedVsixPath(deps, version) {
  const vsixPath = path.posix.join(deps.workDir, vsixFileName(version));
  try {
    deps.readFile(vsixPath);
  } catch {
    throw new Error(
      `${vsixPath} がありません。先に verify を実行してください（照合していない VSIX は公開しません）`,
    );
  }
  return vsixPath;
}

/**
 * GitHub Actions の中でだけ公開できる（OIDC のトークンの発行元が GitHub Actions）。外なら失敗にする。
 * @param {Deps} deps
 * @returns {void}
 */
export function requireGithubActions(deps) {
  if (deps.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('GitHub Actions の中でだけ公開できます（OIDC のトークンの発行元が無い）');
  }
}

/**
 * 配布先の公開 API に版が載るまで待つ（反映の遅れ・一過性の失敗は待つ。上限は CHECK_TIMEOUT_MS）。
 * このステップに来るのは publish が成功（または公開済みで何もしなかった）あとなので、上限を過ぎても載らないのは
 * 「公開は成功・反映未確認」であり、失敗にしない（失敗にすると、公開できているのに run が failure になり、
 * release.mjs install が公開の失敗と案内してしまう）。警告（GitHub Actions の注釈）を出して正常に終える。
 * ただし上限まで公開 API に一度も問い合わせできなかったときは、成否を言えないので失敗にする。
 * @param {Deps} deps
 * @param {{label: string, version: string, isPublished: () => Promise<boolean>}} options isPublished は公開 API の問い合わせ（失敗は例外）
 * @returns {Promise<void>}
 */
export async function waitUntilPublished(deps, { label, version, isPublished }) {
  const deadline = deps.nowMs() + CHECK_TIMEOUT_MS;
  let hasAnswered = false;
  for (;;) {
    try {
      const isListed = await isPublished();
      hasAnswered = true;
      if (isListed) {
        deps.log(`${label} に ${PUBLISHER}.${EXTENSION_NAME}@${version} を確認しました`);
        return;
      }
    } catch (error) {
      deps.log(`公開状況を確認できません（${messageOf(error)}）。待ちを続けます`);
    }
    if (deps.nowMs() + POLL_INTERVAL_MS > deadline) break;
    await deps.sleep(POLL_INTERVAL_MS);
  }
  if (!hasAnswered) {
    throw new Error(
      `${label} の公開状況を一度も確認できませんでした（${CHECK_TIMEOUT_MS / MS_PER_MINUTE} 分間。公開の成否は ${label} のページで確認してください）`,
    );
  }
  deps.log(
    `::warning::公開は成功しましたが、${CHECK_TIMEOUT_MS / MS_PER_MINUTE} 分以内に ${label} の公開 API で ${PUBLISHER}.${EXTENSION_NAME}@${version} の反映を確認できていません（${label} が検証中の可能性があります。release.mjs install が反映を待ちます）`,
  );
}

/**
 * @param {readonly string[]} argv
 * @param {Deps} deps
 * @param {Handlers} handlers 配布先ごとの publish・check
 * @returns {Promise<number>} 終了コード
 */
export async function runCommand(argv, deps, handlers) {
  try {
    const { command, version, waitMinutes } = parseArguments(argv);
    if (command === 'wait') await waitForRelease(deps, { version, waitMinutes });
    else if (command === 'verify') await verifyRelease(deps, { version });
    else if (command === 'publish') await handlers.publish(deps, { version });
    else await handlers.check(deps, { version });
    return 0;
  } catch (error) {
    deps.log(messageOf(error));
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

/**
 * 配布先ごとのスクリプトが直接実行されたときだけ、引数どおりに実行して終了する（import しただけでは何もしない）。
 * @param {string} metaUrl 呼び出し元の import.meta.url
 * @param {Handlers} handlers
 * @returns {void}
 */
export function runAsMain(metaUrl, handlers) {
  if (process.argv[1] === undefined || path.resolve(process.argv[1]) !== fileURLToPath(metaUrl)) {
    return;
  }
  runCommand(process.argv.slice(2), realDeps(), handlers).then(
    (code) => process.exit(code),
    (error) => {
      console.error(messageOf(error));
      process.exit(1);
    },
  );
}
