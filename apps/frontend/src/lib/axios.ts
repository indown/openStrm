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

// 响应拦截器：处理401错误
axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    // 登录接口自己的 401（密码错）不是会话失效：跳转会把整页刷掉，表单和 429 的退避提示都没了
    const isLoginCall = String(error.config?.url ?? "").endsWith("/api/auth/login");
    if (error.response?.status === 401 && !isLoginCall) {
      // 清除无效token
      clearToken();
      // 跳登录页并记住当前位置，登录后回来；已经在登录页就不用再跳
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        const here = window.location.pathname + window.location.search;
        window.location.href = here && here !== '/' ? `/login?next=${encodeURIComponent(here)}` : '/login';
      }
    }
    // 默认密码没改之前，后端会挡下改密码以外的全部接口。
    // 在这里兜住，任何页面误入都会被拉回改密码页。
    if (
      error.response?.status === 403 &&
      error.response?.data?.code === 'PASSWORD_CHANGE_REQUIRED' &&
      typeof window !== 'undefined' &&
      window.location.pathname !== '/change-password'
    ) {
      window.location.href = '/change-password';
    }
    return Promise.reject(error);
  }
);

/** 从 axios 错误里取后端的错误体（统一的 `{ message, ...extra }` 壳） */
export function apiErrorBody(err: unknown): { message?: string; details?: string; code?: string } {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  return data && typeof data === "object" ? (data as { message?: string; details?: string; code?: string }) : {};
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  return apiErrorBody(err).message || fallback;
}

export default axiosInstance;