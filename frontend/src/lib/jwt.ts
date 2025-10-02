import { SignJWT, jwtVerify } from 'jose';

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const secret = new TextEncoder().encode(JWT_SECRET);

export interface TokenPayload {
  username: string;
  iat: number;
  exp: number;
}

// 生成JWT token
export async function generateToken(username: string): Promise<string> {
  const token = await new SignJWT({ username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h') // 24小时过期
    .sign(secret);
  
  return token;
}

// 验证JWT token
export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    
    // 验证payload包含必要字段
    if (typeof payload.username !== 'string' || 
        typeof payload.iat !== 'number' || 
        typeof payload.exp !== 'number') {
      return null;
    }
    
    return {
      username: payload.username,
      iat: payload.iat,
      exp: payload.exp
    };
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
}

// 从请求头中提取token
export function extractTokenFromHeader(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7); // 移除 "Bearer " 前缀
}
