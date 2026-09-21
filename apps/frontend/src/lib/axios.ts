import axios from 'axios';

// 获取存储的token
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('auth-token');
}

// 设置token
export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem('auth-token', token);
}

// 清除token
export function clearToken(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('auth-token');
}

// API base URL: in dev, next.config.ts rewrites /api/* to backend
// In production, same origin or set NEXT_PUBLIC_API_URL
const baseURL = process.env.NEXT_PUBLIC_API_URL || '';

// 创建axios实例
export const axiosInstance = axios.create({
  baseURL,
  timeout: 30000,
});

// 请求拦截器：自动添加token
axiosInstance.interceptors.request.use(
  (config) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

/**
 * 会话失效 / 必须改密码时的跳转。
 *
 * 抽出来是因为事件流那条路走的是 fetch（EventSource 和 axios 都带不了它要的头），
 * 拦截器管不着：不共用的话，流式接口撞上 401 只会显示一句「失败」，
 * 失效的 token 还留在 localStorage 里，人一直点重试也没人告诉他该重新登录。
 */
/**
 * 已经在跳登录页了：同一页上好几个请求先后撞上 401，回跳地址以第一个为准。后面回来的那些可能是页面已经改过地址
 * （比如 ?share= 深链加载完摘掉了参数）之后才到的，再算一遍会把回跳地址改丢。跳转是整页刷新，这个标记跟着清零
 */
let redirectingToLogin = false;

export function handleAuthFailure(status: number, data: unknown, url = ""): void {
  if (typeof window === 'undefined') return;
  const code = (data as { code?: string } | null)?.code;
  // 登录接口自己的 401（密码错）不是会话失效：跳转会把整页刷掉，表单和 429 的退避提示都没了
  const isLoginCall = url.endsWith('/api/auth/login');
  if (status === 401 && !isLoginCall) {
    clearToken();
    // 跳登录页并记住当前位置，登录后回来；已经在登录页就不用再跳
    if (window.location.pathname !== '/login' && !redirectingToLogin) {
      redirectingToLogin = true;
      const here = window.location.pathname + window.location.search;
      window.location.href = here && here !== '/' ? `/login?next=${encodeURIComponent(here)}` : '/login';
    }
  }
  // 默认密码没改之前，后端会挡下改密码以外的全部接口。
  // 在这里兜住，任何页面误入都会被拉回改密码页。
  if (status === 403 && code === 'PASSWORD_CHANGE_REQUIRED' && window.location.pathname !== '/change-password') {
    window.location.href = '/change-password?required=1';
  }
}

/**
 * 把一条 fetch 的失败包成 axios 那种形状，好让 apiErrorBody / apiErrorMessage 一视同仁。
 * 页面上到处在用它们取后端的 `{ message }`，不包的话流式接口的错只剩一句兜底文案。
 */
export function asApiError(status: number, data: unknown, fallback: string): Error {
  const body = data as { message?: string } | null;
  const err = new Error(body?.message || fallback) as Error & { response: { status: number; data: unknown } };
  err.response = { status, data };
  return err;
}

// 响应拦截器：处理401错误
axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    handleAuthFailure(error.response?.status, error.response?.data, String(error.config?.url ?? ""));
    return Promise.reject(error);
  }
);

/** 从 axios 错误里取后端的错误体（统一的 `{ message, ...extra }` 壳） */
export function apiErrorBody(err: unknown): { message?: string; details?: string; code?: string } {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  return data && typeof data === "object" ? (data as { message?: string; details?: string; code?: string }) : {};
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  const message = apiErrorBody(err).message;
  if (message) return message;
  // 后端自己从不回 502 / 504：收到这两个码说明是网关（Cloudflare / 反代）替后端答的——
  // 后端没起来、在重启或没响应，响应体也不是我们的错误壳，别只说一句"失败"
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  if (status === 502 || status === 504) return `${fallback}：网关返回 ${status}，后端可能正在重启或没有响应`;
  return fallback;
}

export default axiosInstance;