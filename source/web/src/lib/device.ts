/**
 * 运行环境探测：引导文案要按"iOS 标签页 / iOS 已安装 / Android / 桌面"分情况给。
 *
 * 只做读取，不做任何跳转或授权动作。
 */
export type Platform = 'ios-safari' | 'ios-standalone' | 'android' | 'desktop';

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS 13+ 的 UA 伪装成 macOS，用触摸点数量区分
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/** 是否运行在"已添加到主屏幕"的独立窗口里（iOS 上是 navigator.standalone，其它浏览器看 display-mode） */
export function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

export function detectPlatform(): Platform {
  if (isIOS()) return isStandalone() ? 'ios-standalone' : 'ios-safari';
  if (/Android/i.test(navigator.userAgent)) return 'android';
  return 'desktop';
}

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationState(): NotificationState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** 通知与推送要求安全上下文：HTTPS 或 localhost */
export function isSecureContextOk(): boolean {
  return window.isSecureContext;
}

export const NOTIFICATION_STATE_LABELS: Record<NotificationState, string> = {
  unsupported: '这个浏览器不支持通知',
  default: '还没授权',
  granted: '已允许',
  denied: '已被拒绝',
};
