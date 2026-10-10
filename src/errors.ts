export class AppError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class DomainError extends AppError {}
export class AuthenticationError extends AppError {
  public constructor(code = 'AUTHENTICATION_REQUIRED', message = 'Authentication is required.') {
    super(code, message, 401);
  }
}
export class AuthorizationError extends AppError {
  public constructor(message = 'Administrator access is required.') {
    super('FORBIDDEN', message, 403);
  }
}
export class ConflictError extends AppError {
  public constructor(code: string, message: string) {
    super(code, message, 409);
  }
}
