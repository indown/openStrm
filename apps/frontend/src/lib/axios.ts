import axios from 'axios';

// 获取存储的token
function getToken(): string | null {
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

// 创建axios实例
export const axiosInstance = axios.create({
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
    if (error.response?.status === 401) {
      // 清除无效token
      clearToken();
      // 跳转到登录页
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default axiosInstance;