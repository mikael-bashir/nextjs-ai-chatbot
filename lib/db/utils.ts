import { genSaltSync, hashSync } from "bcrypt-ts"

export function generateId(length = 12): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

export function generateHashedPassword(password: string) {
  const salt = genSaltSync(10)
  const hash = hashSync(password, salt)

  return hash
}

export function generateDummyPassword() {
  const password = generateId(12)
  const hashedPassword = generateHashedPassword(password)

  return hashedPassword
}
