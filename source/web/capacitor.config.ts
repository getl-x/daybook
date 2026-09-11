import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor（Android 壳）配置。
 *
 * width/height 与 webDir 与 vite 的构建产物对齐；
 * Android 端 WebView 的源是 `https://localhost`（不是 http），因此：
 *   - 前端访问后端必须用绝对地址（默认不写死：原生壳首次启动让用户填；自建者可用 VITE_DAYBOOK_SERVER_URL 预设默认值）；
 *   - 服务端需要放行 `https://localhost` 这个源（见 server 的 CORS 配置）。
 */
const config: CapacitorConfig = {
  appId: "com.getlx.daybook",
  appName: "daybook",
  webDir: "dist",
  backgroundColor: "#FAF7F2",
  loggingBehavior: "debug",
  server: {
    hostname: "localhost",
    androidScheme: "https",
    cleartext: false,
  },
  android: {
    path: "android",
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
