export class AppError extends Error {
  constructor(public code: string, message: string, public status: 400|401|403|404|409|413|422|429|503 = 400) { super(message); }
}
export function requireValue<T>(value: T | null | undefined, message = 'Record not found'): T {
  if (value === null || value === undefined) throw new AppError('NOT_FOUND', message, 404);
  return value;
}
