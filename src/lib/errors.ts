export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class UnauthorizedError extends CliError {
  constructor(message = "Your token is invalid, expired, or was revoked. Please log in first.") {
    super(message, 1);
    this.name = "UnauthorizedError";
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}
