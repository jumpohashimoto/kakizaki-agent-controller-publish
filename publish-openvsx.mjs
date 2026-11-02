// Open VSX への公開（GitHub Actions の Trusted Publishing）。GitLab Release の VSIX を取得・照合して ovsx publish --trusted-publishing で出す。
// このファイルの正本は GitLab のリポジトリの src/github-actions/。公開専用の GitHub リポジトリへは `release.mjs github-sync` が複写する
// （docs/PUBLISHING.md §5.1）。共通の部分（wait・verify・実行の枠）は publish-release.mjs。
//   node publish-openvsx.mjs wait    --version <x.y.z> [--wait-minutes <分>]   GitLab Release が現れるまで待つ
//   node publish-openvsx.mjs verify  --version <x.y.z>                         SHA256SUMS・VSIX を取得し、照合して work/ へ置く
//   node publish-openvsx.mjs publish --version <x.y.z>                         未公開なら ovsx publish --trusted-publishing（公開済みは何もしない）
//   node publish-openvsx.mjs check   --version <x.y.z>                         公開 API に版が載ったことを確かめる
// 秘密は持たない・出さない（OIDC のトークンは ovsx が GitHub の ACTIONS_ID_TOKEN_REQUEST_* から直接取り、open-vsx.org が 5 分で失効する資格に交換する）。
import {
  EXTENSION_NAME,
  isHttpNotFound,
  isHttpOk,
  PUBLISHER,
  request,
  requireGithubActions,
  runAsMain,
  verifiedVsixPath,
  waitUntilPublished,
} from './publish-release.mjs';

const OPEN_VSX_API = 'https://open-vsx.org/api';
const OPEN_VSX_LABEL = 'Open VSX';
/** ovsx は、これがあると Trusted Publishing より優先してトークンで公開する（公開者の資格を使わない経路になるため置かない） */
const ACCESS_TOKEN_ENV_NAME = 'OVSX_PAT';

/** @typedef {import('./publish-release.mjs').Deps} Deps */

/**
 * Open VSX の公開 API（認証なし）で、版が公開済みか。404 は未公開、2xx は公開済み、それ以外は取り違えず失敗にする。
 * @param {Deps} deps
 * @param {string} version
 * @returns {Promise<boolean>}
 */
async function isPublishedOnOpenVsx(deps, version) {
  const response = await request(deps, `${OPEN_VSX_API}/${PUBLISHER}/${EXTENSION_NAME}/${version}`);
  if (isHttpOk(response)) return true;
  if (isHttpNotFound(response)) return false;
  throw new Error(`${OPEN_VSX_LABEL} の公開状況を確認できません（HTTP ${response.status}）`);
}

/**
 * 未公開なら ovsx publish --trusted-publishing で出す（公開済みなら何もしない）。ovsx は GitHub の OIDC トークンを
 * open-vsx.org の短命の資格に交換する（Trusted Publishers の登録と一致したときだけ交換される）。
 * @param {Deps} deps
 * @param {{version: string}} options
 * @returns {Promise<'published' | 'skipped'>}
 */
export async function publishVersion(deps, { version }) {
  if (await isPublishedOnOpenVsx(deps, version)) {
    deps.log(
      `${PUBLISHER}.${EXTENSION_NAME}@${version} は ${OPEN_VSX_LABEL} に公開済みのため、何もしません`,
    );
    return 'skipped';
  }
  const vsixPath = verifiedVsixPath(deps, version);
  requireGithubActions(deps);
  if ((deps.env[ACCESS_TOKEN_ENV_NAME] ?? '') !== '') {
    throw new Error(
      `環境変数 ${ACCESS_TOKEN_ENV_NAME} が設定されています。ovsx はトークンを優先して Trusted Publishing を使わないため、外してください（このリポジトリはトークンを持ちません）`,
    );
  }
  const { status } = await deps.run(
    'npx',
    ['--no-install', 'ovsx', 'publish', vsixPath, '--trusted-publishing', '--skip-duplicate'],
    { inherit: true },
  );
  if (status !== 0) throw new Error(`ovsx publish が失敗しました（終了コード ${status}）`);
  deps.log(`${PUBLISHER}.${EXTENSION_NAME}@${version} を公開しました`);
  return 'published';
}

/**
 * Open VSX の公開 API に版が載るまで待つ（上限・警告の扱いは waitUntilPublished）。
 * @param {Deps} deps
 * @param {{version: string}} options
 * @returns {Promise<void>}
 */
export function checkPublished(deps, { version }) {
  return waitUntilPublished(deps, {
    label: OPEN_VSX_LABEL,
    version,
    isPublished: () => isPublishedOnOpenVsx(deps, version),
  });
}

runAsMain(import.meta.url, { publish: publishVersion, check: checkPublished });
