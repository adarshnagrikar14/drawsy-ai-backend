export type AuthenticatedUser = {
  id: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
};

export interface TokenVerifier {
  verify(token: string): Promise<AuthenticatedUser>;
}
