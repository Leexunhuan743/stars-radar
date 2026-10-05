export class AuthConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

export function authorizeCredential(apiKey, env) {
  const readKey = env?.MCP_API_KEY
  const writeKey = env?.MCP_WRITE_API_KEY

  if (!readKey || !writeKey)
    throw new AuthConfigError('MCP_API_KEY and MCP_WRITE_API_KEY are both required.')
  if (readKey === writeKey)
    throw new AuthConfigError('MCP_API_KEY and MCP_WRITE_API_KEY must be different values.')

  if (apiKey === writeKey)
    return { role: 'write', canRead: true, canWrite: true }
  if (apiKey === readKey)
    return { role: 'read', canRead: true, canWrite: false }
  return { role: 'invalid', canRead: false, canWrite: false }
}
