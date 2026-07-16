// Client- and server-safe admin check. The single admin is identified by email.
export const ADMIN_EMAIL = 'bashir.mikael@outlook.com';

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}
