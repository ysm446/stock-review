// チャットサーバー (127.0.0.1:8001) への共通アクセス。
// トークンは Electron main プロセスが起動時に生成し、サーバー側でヘッダー検証される。
// ブラウザ等の外部オリジンからの操作を防ぐ（CORS だけでは書き込み系リクエストを止められないため）。
export const CHAT_API_BASE = "http://127.0.0.1:8001";

let tokenPromise = null;

export function getApiToken() {
  if (!tokenPromise) {
    tokenPromise = Promise.resolve(
      window.stockReviewApi?.getChatApiToken?.() ?? ""
    ).catch(() => "");
  }
  return tokenPromise;
}

export async function apiFetch(path, options = {}) {
  const token = await getApiToken();
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers["X-Api-Token"] = token;
  }
  return fetch(`${CHAT_API_BASE}${path}`, { ...options, headers });
}
