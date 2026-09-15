import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function encrypt(value: string, secret: string): string {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',Buffer.from(hash(secret),'hex'),iv);
  const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url');
}
export function decrypt(value: string, secret: string): string {
  const raw=Buffer.from(value,'base64url'), decipher=createDecipheriv('aes-256-gcm',Buffer.from(hash(secret),'hex'),raw.subarray(0,12));
  decipher.setAuthTag(raw.subarray(12,28));
  return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8');
}
