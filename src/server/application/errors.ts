export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "request_error"
  ) {
    super(message);
  }
}

export function notFound(entity: string): never {
  throw new ApiError(404, `${entity} was not found`, "not_found");
}
