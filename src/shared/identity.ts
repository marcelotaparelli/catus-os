export const roles = ['administrator', 'manager', 'po', 'developer'] as const;
export type Role = (typeof roles)[number];
export interface SessionView {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string };
  role: Role;
  csrfToken: string;
  expiresAt: string;
  organizations: { id: string; name: string }[];
}
export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
}
