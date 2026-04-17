import crypto from 'crypto'
import dotenv from 'dotenv'
dotenv.config()
const algorithm = 'aes-256-cbc'
const secretKey = crypto
  .createHash('sha256')
  .update(process.env.TOKEN_SECRET_KEY)
  .digest('base64')
  .substring(0, 32)

// Encrypt
export const encrypt = (text) => {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(algorithm, secretKey, iv)

  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')

  return iv.toString('hex') + ':' + encrypted
}

// Decrypt
export const decrypt = (encryptedText) => {
  const [ivHex, encrypted] = encryptedText.split(':')
  const iv = Buffer.from(ivHex, 'hex')

  const decipher = crypto.createDecipheriv(algorithm, secretKey, iv)

  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')

  return decrypted
}
