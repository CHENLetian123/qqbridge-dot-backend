import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const defaultConfigFile = fileURLToPath(
  new URL('../../state/mcp-config.json', import.meta.url),
);
export function loadConfig(filename = defaultConfigFile) {
  filename = path.resolve(filename);
  const base = path.dirname(filename);
  const cfg = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  const readToken = (file) => fs.readFileSync(path.resolve(base, file), 'utf8').trim();
  if (!Number.isSafeInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535)
    throw new Error('Invalid gateway port.');
  return {
    ...cfg,
    configFile: filename,
    token: readToken(cfg.transportTokenFile),
    bridgeToken: readToken(cfg.bridgeTokenFile),
    database: path.resolve(base, cfg.database),
  };
}
