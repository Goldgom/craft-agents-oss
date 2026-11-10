import crypto from 'crypto'
export * from 'crypto'
export default crypto
export const getRandomValues = values => crypto.webcrypto.getRandomValues(values)
