import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 容器');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 注册 Service Worker：PWA 安装与离线壳需要（见计划 §9.3）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // 注册失败不影响使用（例如通过 IP + HTTP 打开时）
    });
  });
}
