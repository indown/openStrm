import { IronSessionOptions } from "iron-session";

export interface SessionData {
  user?: {
    username: string;
    expiresAt: number; // 毫秒时间戳
  };
}

export const sessionOptions: IronSessionOptions = {
  password: process.env.SESSION_SECRET || "complex_password_at_least_32_characters",
  cookieName: "myapp_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60, // 1天，单位秒
  },
};
