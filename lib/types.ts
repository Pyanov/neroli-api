export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface ApiError {
  error: string;
  code?: string;
}

export interface ChatRequest {
  conversationId?: string;
  message: string;
}

export interface UserProfile {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: Date;
}
