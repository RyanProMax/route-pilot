// Input/output pipes only: no credentials in argv or generated public artifacts.
import { readFileSync } from 'node:fs';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
const input = JSON.parse(readFileSync(0,'utf8'));
const token_hash = createHash('sha256').update(input.token).digest('hex');
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm',Buffer.from(input.key,'base64'),iv);
cipher.setAAD(Buffer.from(`route-pilot:v1:${input.instance}:${input.id}:${token_hash}`));
const encrypted = Buffer.concat([cipher.update(JSON.stringify(input.files),'utf8'),cipher.final(),cipher.getAuthTag()]);
process.stdout.write(JSON.stringify({id:input.id,token_hash,iv:iv.toString('base64'),ciphertext:encrypted.toString('base64')}));
