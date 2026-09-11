/**
 * VAPID 密钥解析：让 Web Push「无需在 .env 里手配密钥」也能开箱可用。
 *
 * 优先级（向后兼容）：
 *  1. 环境变量已提供（config.vapid 非空）→ 直接用，最优先；
 *  2. 否则读 app_settings 里保存的密钥（key = vapid_keys，JSON）；
 *  3. 都没有（或存的 JSON 不合法）→ 用 web-push 生成一对，写回数据库。
 *
 * 返回值形状与 config.VapidConfig 一致，buildApp 直接复用即可。
 */
import webpush from 'web-push';

import type { AppStore } from './app.ts';
import type { VapidConfig } from './config.ts';

/** app_settings 里保存 VAPID 密钥用的键名 */
export const VAPID_SETTING_KEY = 'vapid_keys';

/** 与 config.parseVapid 的默认值保持一致 */
export const DEFAULT_VAPID_SUBJECT = 'mailto:noreply@localhost';

/** 只依赖读写应用设置的存储能力，便于单测注入 */
export type VapidStore = Pick<AppStore, 'getAppSetting' | 'setAppSetting'>;

export interface ResolveVapidOptions {
  /** 来自环境变量的密钥；非空即最优先 */
  envVapid: VapidConfig | null;
  /** 原始 VAPID_SUBJECT（可选）；没有则用默认值 */
  subject?: string;
  store: VapidStore;
  log?(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void;
}

function parseStoredKeys(raw: string): { publicKey: string; privateKey: string } | null {
  try {
    const parsed = JSON.parse(raw) as { publicKey?: unknown; privateKey?: unknown };
    if (
      typeof parsed.publicKey === 'string' &&
      parsed.publicKey !== '' &&
      typeof parsed.privateKey === 'string' &&
      parsed.privateKey !== ''
    ) {
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveVapidKeys({ envVapid, subject, store, log }: ResolveVapidOptions): Promise<VapidConfig> {
  const resolvedSubject = subject?.trim() || DEFAULT_VAPID_SUBJECT;

  // 1) 环境变量最优先（保持既有部署的行为不变）
  if (envVapid) {
    log?.('info', '使用环境变量提供的 VAPID 密钥');
    return envVapid;
  }

  // 2) 读数据库里保存的密钥
  const stored = await store.getAppSetting(VAPID_SETTING_KEY);
  if (stored !== null) {
    const keys = parseStoredKeys(stored);
    if (keys) {
      log?.('info', '使用数据库中已保存的 VAPID 密钥');
      return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: resolvedSubject };
    }
    log?.('warn', '数据库里的 VAPID 密钥不是合法 JSON，将重新生成一对');
  }

  // 3) 自动生成并写回数据库
  const generated = webpush.generateVAPIDKeys();
  await store.setAppSetting(VAPID_SETTING_KEY, JSON.stringify(generated));
  log?.('info', '已自动生成 VAPID 密钥并存入数据库（无需手配 .env）');
  return { publicKey: generated.publicKey, privateKey: generated.privateKey, subject: resolvedSubject };
}
